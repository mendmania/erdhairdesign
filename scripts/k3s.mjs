// Offline manifest renderer. This script never invokes kubectl or changes a cluster.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  hostname: { type: 'string' }, image: { type: 'string' }, 'pull-secret': { type: 'string' },
} });
const mode = positionals[0];
const ns = 'erdhairdesign';
const labels = { 'app.kubernetes.io/name': ns, 'app.kubernetes.io/component': 'web' };
const edgeLabels = { 'app.kubernetes.io/name': 'edge-caddy', 'app.kubernetes.io/component': 'edge' };
function resource(kind, name, spec, apiVersion = 'v1', namespace = ns) {
  return { apiVersion, kind, metadata: { name, ...(namespace ? { namespace } : {}), labels: { 'app.kubernetes.io/part-of': ns } }, ...(spec ? { spec } : {}) };
}
function hostname() {
  const h = values.hostname;
  if (!h || h.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(h)) throw new Error('Supply --hostname with the salon’s actual DNS hostname, without a scheme or path.');
  return h;
}
function foundation() {
  const namespace = resource('Namespace', ns, null, 'v1', null);
  Object.assign(namespace.metadata.labels, { 'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/enforce-version': 'v1.35', 'pod-security.kubernetes.io/audit': 'restricted', 'pod-security.kubernetes.io/warn': 'restricted' });
  const storage = resource('StorageClass', `${ns}-local-retain`, null, 'storage.k8s.io/v1', null);
  Object.assign(storage, { provisioner: 'rancher.io/local-path', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer' });
  return [namespace, storage,
    resource('PersistentVolumeClaim', `${ns}-data`, { accessModes: ['ReadWriteOnce'], storageClassName: storage.metadata.name, resources: { requests: { storage: '2Gi' } } }),
    resource('NetworkPolicy', `${ns}-default-deny`, { podSelector: {}, policyTypes: ['Ingress', 'Egress'] }, 'networking.k8s.io/v1'),
  ];
}
function app() {
  const host = hostname();
  if (!values.image || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(values.image)) throw new Error('Supply --image with a registry image pinned to its actual sha256 digest.');
  if (values['pull-secret'] && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(values['pull-secret'])) throw new Error('Invalid image pull Secret name.');
  const config = resource('ConfigMap', `${ns}-config`);
  config.data = { NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3000', APP_URL: `https://${host}`, DATABASE_PATH: '/data/salon.sqlite', SALON_TIMEZONE: 'Europe/Belgrade', TRUST_PROXY: 'true' };
  const container = {
    name: 'web', image: values.image, imagePullPolicy: 'IfNotPresent', ports: [{ name: 'http', containerPort: 3000 }],
    envFrom: [{ configMapRef: { name: config.metadata.name } }, { secretRef: { name: `${ns}-email` } }],
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
    resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } },
    volumeMounts: [{ name: 'data', mountPath: '/data' }, { name: 'tmp', mountPath: '/tmp' }],
    startupProbe: { httpGet: { path: '/health/ready', port: 'http' }, periodSeconds: 3, timeoutSeconds: 2, failureThreshold: 30 },
    readinessProbe: { httpGet: { path: '/health/ready', port: 'http' }, periodSeconds: 5, timeoutSeconds: 2 },
    livenessProbe: { httpGet: { path: '/health/live', port: 'http' }, periodSeconds: 15, timeoutSeconds: 2, failureThreshold: 3 },
  };
  const deployment = resource('Deployment', ns, {
    replicas: 1, strategy: { type: 'Recreate' }, revisionHistoryLimit: 3, progressDeadlineSeconds: 180,
    selector: { matchLabels: labels }, template: {
      metadata: { labels, annotations: { 'erdhairdesign/config-sha256': createHash('sha256').update(JSON.stringify(config.data)).digest('hex') } },
      spec: {
        automountServiceAccountToken: false, terminationGracePeriodSeconds: 30,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
        ...(values['pull-secret'] ? { imagePullSecrets: [{ name: values['pull-secret'] }] } : {}),
        containers: [container], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${ns}-data` } }, { name: 'tmp', emptyDir: { sizeLimit: '32Mi' } }],
      },
    },
  }, 'apps/v1');
  const network = resource('NetworkPolicy', `${ns}-web`, {
    podSelector: { matchLabels: labels }, policyTypes: ['Ingress', 'Egress'],
    ingress: [{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'edge-caddy' } }, podSelector: { matchLabels: edgeLabels } }], ports: [{ protocol: 'TCP', port: 3000 }] }],
    egress: [
      { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
      { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4'] } }], ports: [{ protocol: 'TCP', port: 443 }] },
    ],
  }, 'networking.k8s.io/v1');
  return [config, network, resource('Service', ns, { type: 'ClusterIP', selector: labels, ports: [{ name: 'http', port: 3000, targetPort: 'http' }] }), deployment];
}
function edgePolicy() {
  return [resource('NetworkPolicy', 'edge-to-erdhairdesign', {
    podSelector: { matchLabels: edgeLabels }, policyTypes: ['Egress'], egress: [{
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': ns } }, podSelector: { matchLabels: labels } }], ports: [{ protocol: 'TCP', port: 3000 }],
    }],
  }, 'networking.k8s.io/v1', 'edge-caddy')];
}
try {
  if (mode === 'caddy') {
    console.log(`# BEGIN ERD HAIR DESIGN\n${hostname()} {\n  tls {\n    issuer acme {\n      dir https://acme-v02.api.letsencrypt.org/directory\n    }\n  }\n  encode zstd gzip\n  request_body {\n    max_size 32KB\n  }\n  @health path /health/*\n  respond @health 404\n  reverse_proxy erdhairdesign.erdhairdesign.svc.cluster.local:3000 {\n    header_up X-Erd-Client-IP {remote_host}\n    header_up -Authorization\n    header_up -X-Real-IP\n    header_up -True-Client-IP\n    header_up -CF-Connecting-IP\n    header_up -Forwarded\n  }\n}\n# END ERD HAIR DESIGN`);
  } else {
    const items = mode === 'foundation' ? foundation() : mode === 'app' ? app() : mode === 'edge-policy' ? edgePolicy() : null;
    if (!items) throw new Error('Usage: node scripts/k3s.mjs foundation|app|edge-policy|caddy [--hostname HOST] [--image IMAGE@sha256:DIGEST] [--pull-secret NAME]');
    console.log(JSON.stringify({ apiVersion: 'v1', kind: 'List', items }, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
