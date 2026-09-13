import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

const digest = `ghcr.io/example/salon@sha256:${'a'.repeat(64)}`;
const render = (...args) => execFileSync(process.execPath, ['scripts/k3s.mjs', ...args], { encoding: 'utf8' });
test('the deployment requires an explicit hostname and immutable image', () => {
  for (const args of [[], ['--hostname', 'salon.example.com', '--image', 'salon:latest'], ['--hostname', 'salon.example.com\nrruge.com', '--image', digest]]) {
    const result = spawnSync(process.execPath, ['scripts/k3s.mjs', 'app', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});
test('salon resources keep SQLite on retained storage and only allow one non-root replica', () => {
  const foundation = JSON.parse(render('foundation')).items;
  assert.equal(foundation.find(r => r.kind === 'StorageClass').reclaimPolicy, 'Retain');
  const resources = JSON.parse(render('app', '--hostname', 'salon.example.com', '--image', digest)).items;
  assert.ok(resources.every(r => r.metadata.namespace === 'erdhairdesign'));
  assert.ok(resources.every(r => r.kind !== 'Secret' && r.kind !== 'Ingress'));
  const deployment = resources.find(r => r.kind === 'Deployment');
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  const pod = deployment.spec.template.spec;
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.ok(pod.volumes.some(v => v.persistentVolumeClaim?.claimName === 'erdhairdesign-data'));
  assert.equal(resources.find(r => r.kind === 'Service').spec.type, 'ClusterIP');
  assert.equal(resources.find(r => r.kind === 'ConfigMap').data.NODE_ENV, 'production');
});
test('shared edge additions are narrowly scoped and overwrite the client identity header', () => {
  const policies = JSON.parse(render('edge-policy')).items;
  assert.equal(policies.length, 1);
  assert.equal(policies[0].kind, 'NetworkPolicy');
  const rule = policies[0].spec.egress[0];
  assert.equal(rule.to[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'], 'erdhairdesign');
  assert.deepEqual(rule.ports, [{ protocol: 'TCP', port: 3000 }]);
  const caddy = render('caddy', '--hostname', 'salon.example.com');
  assert.match(caddy, /header_up X-Erd-Client-IP \{remote_host\}/);
  assert.match(caddy, /erdhairdesign\.erdhairdesign\.svc\.cluster\.local:3000/);
  assert.ok(!caddy.includes('rruge.com'));
});
