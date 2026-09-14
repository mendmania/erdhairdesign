import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeployer, validateCluster, assertOwned, expectedServer } from '../scripts/deploy.mjs';

const owned = { 'app.kubernetes.io/part-of': 'erdhairdesign' };
const config = { 'current-context': 'salon', contexts: [{ name: 'salon', context: { cluster: 'netcup' } }], clusters: [{ name: 'netcup', cluster: { server: expectedServer } }] };
const nodes = { items: [{ metadata: { name: 'netcupmaniaserver' }, status: { nodeInfo: { architecture: 'amd64' }, conditions: [{ type: 'Ready', status: 'True' }] } }] };
const edge = { spec: { template: { metadata: { labels: { 'app.kubernetes.io/name': 'edge-caddy', 'app.kubernetes.io/component': 'edge' } } } }, status: { readyReplicas: 1 } };
const storage = { items: [{ provisioner: 'rancher.io/local-path' }] };
const policies = { items: [{ spec: { policyTypes: ['Egress'], podSelector: { matchLabels: { 'app.kubernetes.io/name': 'edge-caddy' } } } }] };
const image = `ghcr.io/example/salon@sha256:${'a'.repeat(64)}`;
const options = { hostname: 'salon.example.com', image };
function fake({ wrongCluster = false, collision = false, emailKeys = 'BREVO_API_KEY\nEMAIL_FROM\n', failDryRun = false } = {}) {
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    if (args.includes('config')) return JSON.stringify(wrongCluster ? { ...config, clusters: [{ name: 'netcup', cluster: { server: 'https://unrelated.example' } }] } : config);
    const index = args.indexOf('get');
    const kind = args[index + 1], name = args[index + 2];
    if (args.includes('go-template={{range $key, $value := .data}}{{$key}}{{"\\n"}}{{end}}')) return emailKeys;
    if (kind === 'nodes') return JSON.stringify(nodes);
    if (kind === 'deployment' && name === 'edge-caddy') return JSON.stringify(edge);
    if (kind === 'storageclass' && name === '-o') return JSON.stringify(storage);
    if (kind === 'networkpolicy') return JSON.stringify(policies);
    if (kind === 'namespace') return '';
    if (kind === 'Namespace' || kind === 'NetworkPolicy') return JSON.stringify({ metadata: { labels: owned } });
    if (kind === 'StorageClass') return JSON.stringify({ metadata: { labels: collision ? {} : owned }, provisioner: 'rancher.io/local-path', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer' });
    if (kind === 'PersistentVolumeClaim') return JSON.stringify({ metadata: { labels: owned }, spec: { storageClassName: 'erdhairdesign-local-retain', accessModes: ['ReadWriteOnce'] } });
    if (args.includes('apply')) { if (failDryRun && args.includes('--dry-run=server')) throw new Error('API validation failed'); return 'validated'; }
    if (args.includes('rollout')) return 'ready';
    return '';
  };
  return { calls, deployer: createDeployer('/tmp/explicit-salon-kubeconfig', run) };
}
test('deployment refuses an implicit kubeconfig and a wrong cluster before network calls', () => {
  assert.throws(() => createDeployer(), /explicitly/);
  const { deployer, calls } = fake({ wrongCluster: true });
  assert.throws(() => deployer.bootstrap(), /Wrong cluster/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('config'));
});
test('preflight requires verified TLS, a ready AMD64 node and an already isolated edge', () => {
  assert.doesNotThrow(() => validateCluster(config, nodes, edge, storage, policies));
  const insecure = structuredClone(config); insecure.clusters[0].cluster['insecure-skip-tls-verify'] = true;
  assert.throws(() => validateCluster(insecure, nodes, edge, storage, policies), /TLS/);
  const arm = structuredClone(nodes); arm.items[0].status.nodeInfo.architecture = 'arm64';
  assert.throws(() => validateCluster(config, arm, edge, storage, policies), /architecture/);
  assert.throws(() => validateCluster(config, nodes, edge, storage, { items: [] }), /egress-isolated/);
});
test('resource collisions and incompatible storage are rejected before bootstrap mutations', () => {
  const { deployer, calls } = fake({ collision: true });
  assert.throws(() => deployer.bootstrap(), /unowned/);
  assert.ok(!calls.some(c => c.args.includes('apply')));
  assert.throws(() => assertOwned({ metadata: { labels: owned }, spec: { storageClassName: 'other' } }, { kind: 'PersistentVolumeClaim', metadata: { name: 'data' }, spec: { storageClassName: 'expected' } }), /incompatible/);
});
test('bootstrap dry-runs cluster resources before creation and never starts a workload', () => {
  const { deployer, calls } = fake(); deployer.bootstrap();
  const applied = calls.filter(c => c.args.includes('apply'));
  assert.equal(applied.length, 4);
  assert.ok(applied[0].args.includes('--dry-run=server'));
  assert.ok(JSON.parse(applied[0].input).items.every(r => !r.metadata.namespace));
  assert.ok(applied.every(c => JSON.parse(c.input).items.every(r => r.kind !== 'Deployment' && r.kind !== 'Secret')));
});
test('dry-run failure prevents application mutation', () => {
  const { deployer, calls } = fake({ failDryRun: true });
  assert.throws(() => deployer.deploy(options), /validation failed/);
  assert.ok(!calls.some(c => c.args.includes('apply') && !c.args.includes('--dry-run=server')));
});
test('production secrets cannot override runtime mode and missing email keys block rollout', () => {
  for (const emailKeys of ['BREVO_API_KEY\n', 'BREVO_API_KEY\nEMAIL_FROM\nNODE_ENV\n']) {
    const { deployer, calls } = fake({ emailKeys });
    assert.throws(() => deployer.deploy(options), /Secret/);
    assert.ok(!calls.some(c => c.args.includes('apply')));
  }
});
test('application dry-run is nonmutating and a real deploy waits for rollout without changing the edge', () => {
  const dry = fake(); dry.deployer.deploy(options, true);
  assert.ok(dry.calls.filter(c => c.args.includes('apply')).every(c => c.args.includes('--dry-run=server')));
  assert.ok(!dry.calls.some(c => c.args.includes('rollout')));
  const real = fake(); real.deployer.deploy(options);
  assert.ok(real.calls.some(c => c.args.includes('rollout')));
  const manifests = real.calls.filter(c => c.input).map(c => JSON.parse(c.input));
  assert.ok(manifests.every(m => m.items.every(r => r.metadata.namespace === 'erdhairdesign' && r.kind !== 'Secret')));
  assert.ok(real.calls.every(c => c.args[0] === '--kubeconfig' && c.args[1] === '/tmp/explicit-salon-kubeconfig'));
});
