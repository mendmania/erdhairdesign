// Explicit-cluster deployment helper. Shared edge routing remains a separate cutover.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const namespace = 'erdhairdesign';
const owner = 'app.kubernetes.io/part-of';
export const expectedServer = 'https://159.195.30.113:6443';
const nodeName = 'netcupmaniaserver';
const edgeLabels = { 'app.kubernetes.io/name': 'edge-caddy', 'app.kubernetes.io/component': 'edge' };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const list = items => ({ apiVersion: 'v1', kind: 'List', items });

export function validateCluster(config, nodes, edge, storage, policies) {
  const context = config.contexts?.find(c => c.name === config['current-context'])?.context;
  const cluster = config.clusters?.find(c => c.name === context?.cluster)?.cluster;
  assert(cluster?.server === expectedServer && !cluster['insecure-skip-tls-verify'], `Select the verified rruge.com cluster at ${expectedServer}, with TLS verification enabled.`);
  const node = nodes.items?.find(n => n.metadata.name === nodeName);
  assert(node?.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'), 'The expected Netcup node is not Ready.');
  assert(node.status.nodeInfo.architecture === 'amd64', 'Node architecture changed; review the release build platform.');
  assert(edge.status?.readyReplicas >= 1 && Object.entries(edgeLabels).every(([k,v]) => edge.spec.template.metadata.labels[k] === v), 'The shared Caddy edge is unavailable or its labels changed.');
  assert(storage.items?.some(s => s.provisioner === 'rancher.io/local-path'), 'The local-path storage provisioner is missing.');
  // Adding the first Egress policy would unexpectedly isolate the shared edge.
  const selected = policies.items?.some(p => p.spec.policyTypes?.includes('Egress') && !p.spec.podSelector.matchExpressions?.length && Object.entries(p.spec.podSelector.matchLabels || {}).every(([k,v]) => edge.spec.template.metadata.labels[k] === v));
  assert(selected, 'The edge is not already egress-isolated; review policies before adding a salon allowance.');
}

export function assertOwned(existing, desired) {
  assert(existing.metadata?.labels?.[owner] === namespace, `Refusing to adopt unowned ${desired.kind}/${desired.metadata.name}.`);
  if (desired.kind === 'PersistentVolumeClaim') {
    assert(existing.spec.storageClassName === desired.spec.storageClassName && existing.spec.accessModes?.includes('ReadWriteOnce'), 'Existing salon PVC has incompatible storage settings.');
  }
  if (desired.kind === 'StorageClass') {
    assert(existing.provisioner === desired.provisioner && existing.reclaimPolicy === 'Retain' && existing.volumeBindingMode === desired.volumeBindingMode, 'Existing salon StorageClass has incompatible settings.');
  }
}

export function createDeployer(kubeconfig, run = (args, input) => execFileSync('kubectl', args, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })) {
  assert(kubeconfig, 'Supply --kubeconfig explicitly. The current kubectl context is never used.');
  const base = ['--kubeconfig', resolve(kubeconfig), '--request-timeout=15s'];
  const call = (args, input) => run([...base, ...args], input);
  const get = (kind, name, ns) => {
    const output = call([...(ns ? ['-n', ns] : []), 'get', kind, ...(name ? [name, '--ignore-not-found'] : []), '-o', 'json']);
    return output.trim() ? JSON.parse(output) : null;
  };
  const render = (mode, options = {}) => {
    const args = Object.entries(options).filter(([,v]) => v).flatMap(([k,v]) => [`--${k}`, v]);
    const result = execFileSync(process.execPath, [resolve(root, 'scripts/k3s.mjs'), mode, ...args], { encoding: 'utf8' });
    return mode === 'caddy' ? result : JSON.parse(result);
  };
  function check() {
    // Verify connection identity locally before sending any API request.
    const config = JSON.parse(call(['config', 'view', '-o', 'json']));
    const context = config.contexts?.find(c => c.name === config['current-context'])?.context;
    const cluster = config.clusters?.find(c => c.name === context?.cluster)?.cluster;
    assert(cluster?.server === expectedServer && !cluster['insecure-skip-tls-verify'], `Wrong cluster. Expected ${expectedServer} with TLS verification.`);
    validateCluster(config, get('nodes'), get('deployment', 'edge-caddy', 'edge-caddy'), get('storageclass'), get('networkpolicy', null, 'edge-caddy'));
    return { server: expectedServer, node: nodeName, platform: 'linux/amd64', edgeReady: true };
  }
  function inspect(manifest) {
    for (const item of manifest.items) {
      const existing = get(item.kind, item.metadata.name, item.metadata.namespace);
      if (existing) assertOwned(existing, item);
    }
  }
  const apply = (manifest, dry = false) => call(['apply', ...(dry ? ['--dry-run=server'] : []), '-f', '-'], JSON.stringify(manifest));
  function bootstrap() {
    check();
    const foundation = render('foundation');
    // Check every collision before making any change. Namespaced reads require a namespace.
    const existingNamespace = get('namespace', namespace);
    inspect(list(foundation.items.filter(r => !r.metadata.namespace || existingNamespace)));
    const clusterResources = list(foundation.items.filter(r => !r.metadata.namespace));
    apply(clusterResources, true);
    apply(clusterResources);
    apply(foundation, true);
    apply(foundation);
    return 'Salon namespace, retained storage and default-deny policy are ready. No application or public route was started.';
  }
  function plan(options, output) {
    check();
    const app = render('app', options);
    const foundation = render('foundation');
    const edge = render('edge-policy');
    const caddy = render('caddy', { hostname: options.hostname });
    const destination = resolve(output);
    assert(!existsSync(destination), 'Output directory already exists; use a new release directory to preserve the previous plan.');
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const [name, data] of Object.entries({ 'foundation.json': foundation, 'app.json': app, 'edge-policy.json': edge, 'release.json': { hostname: options.hostname, image: options.image, platform: 'linux/amd64', server: expectedServer, createdAt: new Date().toISOString() } })) {
      writeFileSync(resolve(destination, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    }
    writeFileSync(resolve(destination, 'Caddyfile.salon'), caddy, { mode: 0o600 });
    return destination;
  }
  function deploy(options, dry = false) {
    check();
    const app = render('app', options);
    const foundation = render('foundation');
    for (const item of foundation.items) {
      const existing = get(item.kind, item.metadata.name, item.metadata.namespace);
      assert(existing, 'Run bootstrap first.');
      assertOwned(existing, item);
    }
    inspect(app);
    // Project only key names; never retrieve Secret values into output or local manifests.
    const keys = call(['-n', namespace, 'get', 'secret', `${namespace}-email`, '-o', 'go-template={{range $key, $value := .data}}{{$key}}{{"\\n"}}{{end}}']);
    assert(['BREVO_API_KEY', 'EMAIL_FROM'].every(k => keys.split('\n').includes(k)), 'The salon email Secret must contain BREVO_API_KEY and EMAIL_FROM.');
    assert(keys.trim().split('\n').every(k => ['BREVO_API_KEY','EMAIL_FROM'].includes(k)), 'The email Secret contains unexpected keys that could override production settings.');
    if (options['pull-secret']) {
      const type = call(['-n', namespace, 'get', 'secret', options['pull-secret'], '-o', 'jsonpath={.type}']);
      assert(type === 'kubernetes.io/dockerconfigjson', 'The registry Secret must be a dockerconfigjson Secret.');
    }
    apply(app, true);
    if (dry) return 'Application server dry-run passed. No workload was changed.';
    apply(app);
    call(['-n', namespace, 'rollout', 'status', `deployment/${namespace}`, '--timeout=180s']);
    return 'Application rollout is ready inside the cluster. Configure the shared edge and DNS before announcing a public URL.';
  }
  return { check, bootstrap, plan, deploy };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      kubeconfig: { type: 'string' }, hostname: { type: 'string' }, image: { type: 'string' },
      'pull-secret': { type: 'string' }, output: { type: 'string' }, 'dry-run': { type: 'boolean' },
    } });
    const command = positionals[0];
    assert(['check', 'bootstrap', 'plan', 'deploy'].includes(command), 'Usage: node scripts/deploy.mjs check|bootstrap|plan|deploy --kubeconfig PATH [--hostname HOST --image IMAGE@sha256:DIGEST --pull-secret NAME --output NEW_DIRECTORY --dry-run]');
    const deployer = createDeployer(values.kubeconfig);
    const options = { hostname: values.hostname, image: values.image, 'pull-secret': values['pull-secret'] };
    if (command === 'check') console.log(JSON.stringify(deployer.check(), null, 2));
    if (command === 'bootstrap') console.log(deployer.bootstrap());
    if (command === 'plan') { assert(values.output, 'Supply --output with a new release directory.'); console.log(deployer.plan(options, values.output)); }
    if (command === 'deploy') console.log(deployer.deploy(options, values['dry-run']));
  } catch (error) {
    // kubectl can include API response bodies in failures; keep provider output private.
    console.error(error.status !== undefined ? `Deployment command failed (exit ${error.status}). Inspect cluster status with the explicitly selected kubeconfig; no automatic rollback or storage deletion was attempted.` : error.message);
    process.exitCode = 1;
  }
}
