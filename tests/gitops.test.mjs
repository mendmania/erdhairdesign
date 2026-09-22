import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseJob, publishRequest, verifyRevision } from '../scripts/gitops.mjs';
import { assertMain } from '../scripts/cluster-release.mjs';
const options = { image: `ghcr.io/mendmania/erdhairdesign@sha256:${'a'.repeat(64)}`, deployerImage: `ghcr.io/mendmania/erdhairdesign@sha256:${'b'.repeat(64)}`, revision: 'c'.repeat(40), runId: '123', attempt: '1' };

test('release jobs use bounded, isolated credentials and immutable images', () => {
  const job = releaseJob(options);
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 480);
  const pod = job.spec.template.spec;
  assert.equal(pod.serviceAccountName, 'github-deployer');
  assert.equal(pod.automountServiceAccountToken, true);
  assert.equal(pod.containers[0].image, options.deployerImage);
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.ok(pod.volumes.every(v => !v.persistentVolumeClaim && !v.hostPath && !v.secret));
  for (const changed of [{ image: 'ghcr.io/mendmania/erdhairdesign:latest' }, { deployerImage: 'evil.example/release@sha256:' + 'b'.repeat(64) }, { revision: 'main' }, { runId: '../bad' }, { attempt: 'x' }]) assert.throws(() => releaseJob({ ...options, ...changed }));
});
function apiMock({ existing = true, staleOn = 0, readFails = false } = {}) {
  const calls = []; let reads = 0;
  return { calls, api: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith('/main')) return { object: { sha: ++reads === staleOn ? 'd'.repeat(40) : options.revision } };
    if (path.includes('matching-refs')) { if (readFails) throw new Error('network failed'); return existing ? [{ ref: 'refs/heads/salon-production', object: { sha: 'previous' } }] : []; }
    return { sha: 'created' };
  } };
}
test('publishing advances only the production branch without force and preserves its history', async () => {
  const f = apiMock(); await publishRequest(options, f.api);
  assert.deepEqual(f.calls.find(c => c.path === '/git/commits').body.parents, ['previous']);
  assert.deepEqual(f.calls.at(-1), { method: 'PATCH', path: '/git/refs/heads/salon-production', body: { sha: 'created', force: false } });
  assert.ok(!f.calls.some(c => c.method !== 'GET' && c.path.endsWith('/main')));
  const fresh = apiMock({ existing: false }); await publishRequest(options, fresh.api);
  assert.equal(fresh.calls.at(-1).body.ref, 'refs/heads/salon-production');
});
test('stale commits and failed branch reads cannot publish a release', async () => {
  for (const config of [{ staleOn: 1 }, { staleOn: 2 }, { readFails: true }]) {
    const f = apiMock(config); await assert.rejects(publishRequest(options, f.api));
    assert.ok(!f.calls.some(c => c.method !== 'GET' && c.path.startsWith('/git/refs')));
  }
});
test('cluster freshness fails closed on stale main or unavailable GitHub', async () => {
  await assertMain(options.revision, async () => Response.json({ object: { sha: options.revision } }));
  await assert.rejects(assertMain(options.revision, async () => Response.json({ object: { sha: 'old' } })));
  await assert.rejects(assertMain(options.revision, async () => new Response('', { status: 403 })));
});
test('production verification rejects a healthy site running the wrong revision', async () => {
  await verifyRevision(options.revision, async () => Response.json({ revision: options.revision }));
  await assert.rejects(verifyRevision(options.revision, async () => Response.json({ revision: 'old' })));
  await assert.rejects(verifyRevision(options.revision, async () => new Response('', { status: 404 })));
});
test('Flux may manage salon release Jobs only and does not own the app or storage', () => {
  const items = JSON.parse(readFileSync(new URL('../infra/k3s/flux-release.json', import.meta.url))).items;
  const role = items.find(i => i.kind === 'Role');
  assert.equal(role.metadata.namespace, 'erdhairdesign');
  assert.deepEqual(role.rules.map(r => r.resources), [['jobs']]);
  const flux = items.find(i => i.kind === 'Kustomization');
  assert.equal(flux.spec.serviceAccountName, 'salon-release-reconciler');
  assert.equal(flux.spec.deletionPolicy, 'Orphan');
  assert.equal(items.find(i => i.kind === 'GitRepository').spec.ref.branch, 'salon-production');
});
