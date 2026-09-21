import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createReleaser, releasePatch, validateDeployment, verifyPublicRelease, backupCode } from '../scripts/release.mjs';
const image = `ghcr.io/mendmania/erdhairdesign@sha256:${'a'.repeat(64)}`;
const nextImage = `ghcr.io/mendmania/erdhairdesign@sha256:${'b'.repeat(64)}`;
const revision = 'c'.repeat(40);
const options = { image: nextImage, revision, runId: '123', attempt: '1' };
const current = () => ({
  metadata: { name: 'erdhairdesign', namespace: 'erdhairdesign', labels: { 'app.kubernetes.io/part-of': 'erdhairdesign' }, generation: 2, resourceVersion: '42' },
  spec: { replicas: 1, strategy: { type: 'Recreate' }, template: {
    metadata: { annotations: { 'existing-setting': 'preserved' } },
    spec: { containers: [{ name: 'web', image, envFrom: [{secretRef:{name:'erdhairdesign-email'}}], volumeMounts: [{name:'data',mountPath:'/data'}] }], volumes: [{name:'data',persistentVolumeClaim:{claimName:'erdhairdesign-data'}}] },
  } },
  status: { observedGeneration: 2, readyReplicas: 1, updatedReplicas: 1 },
});
function fake({ wrongCluster = false, backupFails = false, dryRunFails = false, rolloutFails = false, concurrentImage = false, unready = false } = {}) {
  const calls = []; let deployed = false, reads = 0;
  const run = (args,input) => {
    calls.push({args,input});
    if (args.includes('config')) return JSON.stringify({clusters:[{cluster:{server:wrongCluster ? 'https://wrong.example' : 'https://159.195.30.113:6443','certificate-authority-data':'test-ca'}}]});
    if (args.includes('get') && args.includes('deployment')) {
      const result = current(); reads++;
      if (deployed || (concurrentImage && reads > 1)) result.spec.template.spec.containers[0].image = nextImage;
      if (unready) result.status.readyReplicas = 0;
      return JSON.stringify(result);
    }
    if (args.includes('get') && args.includes('pods')) return JSON.stringify({items:[{metadata:{name:'salon-pod'},spec:{nodeName:'netcupmaniaserver',containers:[{name:'web',image}]},status:{conditions:[{type:'Ready',status:'True'}]}}]});
    if (args.includes('patch')) {
      if (args.includes('--dry-run=server') && dryRunFails) throw new Error('dry-run failed');
      if (!args.includes('--dry-run=server')) deployed = true;
    }
    if (args.includes(backupCode) && backupFails) throw new Error('backup failed');
    if (args.includes('rollout') && rolloutFails) throw new Error('rollout failed');
    return '';
  };
  return {calls,release:createReleaser('/tmp/salon-only',run)};
}
const mutations = calls => calls.filter(c => c.args.includes('patch') && !c.args.includes('--dry-run=server'));
test('release rejects wrong cluster, mutable images and invalid backup identities before changes',async()=>{
  assert.throws(()=>createReleaser(),/explicit/);
  for (const bad of [{image:'ghcr.io/mendmania/erdhairdesign:latest'}, {revision:'../bad'}, {runId:'x'}, {attempt:'../1'}]) {
    const f=fake(); await assert.rejects(f.release({...options,...bad})); assert.equal(f.calls.length,0);
  }
  const f=fake({wrongCluster:true}); await assert.rejects(f.release(options),/cluster/); assert.equal(f.calls.length,1);
});
test('release refuses unowned deployments, multiple replicas, changed storage and unready apps',()=>{
  for (const mutate of [d=>d.metadata.labels={},d=>d.spec.replicas=2,d=>d.spec.strategy.type='RollingUpdate',d=>d.spec.template.spec.volumes=[],d=>d.status.readyReplicas=0]) {
    const d=current(); mutate(d); assert.throws(()=>validateDeployment(d));
  }
});
test('only the image and revision change, guarded by resource version and prior image',()=>{
  const d=current(),copy=structuredClone(d),patch=releasePatch(d,nextImage,revision);
  assert.deepEqual(d,copy);
  assert.deepEqual(patch.map(p=>[p.op,p.path]),[
    ['test','/metadata/resourceVersion'],['test','/spec/template/spec/containers/0/image'],
    ['replace','/spec/template/spec/containers/0/image'],['add','/spec/template/metadata/annotations']
  ]);
  assert.equal(patch[3].value['existing-setting'],'preserved');
});
test('backup and server dry-run failures prevent an upgrade',async()=>{
  for (const failure of [{backupFails:true},{dryRunFails:true},{unready:true}]) {
    const f=fake(failure); await assert.rejects(f.release(options)); assert.equal(mutations(f.calls).length,0);
  }
});
test('stale main or a concurrent production change cannot overwrite the newer release',async()=>{
  const stale=fake(); await assert.rejects(stale.release({...options,assertFresh:async()=>{throw new Error('newer main');}}),/newer main/); assert.equal(mutations(stale.calls).length,0);
  const duringBackup=fake();let checks=0;
  await assert.rejects(duringBackup.release({...options,assertFresh:async()=>{if (++checks===2) throw new Error('newer main');}}));
  assert.equal(mutations(duringBackup.calls).length,0);
  const concurrent=fake({concurrentImage:true}); await assert.rejects(concurrent.release(options),/changed during backup/); assert.equal(mutations(concurrent.calls).length,0);
});
test('successful release backs up before mutation and verifies readiness without touching the edge or secrets',async()=>{
  const f=fake();const result=await f.release(options);
  assert.equal(result.image,nextImage);assert.equal(result.previousImage,image);
  assert.equal(result.backupPath,`/data/backups/release-${revision}-123-1.sqlite`);
  const backupIndex=f.calls.findIndex(c=>c.args.includes(backupCode));
  assert.ok(backupIndex<f.calls.findIndex(c=>mutations([c]).length));
  assert.equal(mutations(f.calls).length,1);
  assert.ok(f.calls.some(c=>c.args.includes('rollout')));
  assert.ok(f.calls.every(c=>!c.args.includes('secret')&&!c.args.includes('edge-caddy')&&!c.args.includes('delete')&&!c.args.includes('apply')));
});
test('failed rollout does not restore data or automatically roll back a potentially migrated database',async()=>{
  const f=fake({rolloutFails:true}); await assert.rejects(f.release(options),/rollout/);
  assert.equal(mutations(f.calls).length,1);
  assert.ok(!f.calls.some(c=>c.args.includes('undo')||c.args.includes('delete')));
});
test('public verification rejects stale assets and unhealthy bootstrap',async()=>{
  const appJs=Buffer.from('new release');
  const response=content=>new Response(content,{status:200});
  await verifyPublicRelease({revision,appJs},async url=>url.includes('app.js')?response(appJs):response(JSON.stringify({services:[]})));
  await assert.rejects(verifyPublicRelease({revision,appJs},async()=>response('old release')),/different application code/);
  await assert.rejects(verifyPublicRelease({revision,appJs},async url=>url.includes('app.js')?response(appJs):new Response('',{status:503})),/Public application/);
});
test('online backup captures committed WAL data and survives later writes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'salon-release-'));
  let db,snapshot;
  try {
    db=new DatabaseSync(join(dir,'salon.sqlite'));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE bookings (id TEXT); INSERT INTO bookings VALUES (\'before\')');
    await backup(db,join(dir,'backup.sqlite'));
    db.exec("INSERT INTO bookings VALUES ('after')");
    snapshot=new DatabaseSync(join(dir,'backup.sqlite'),{readOnly:true});
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(snapshot.prepare('SELECT id FROM bookings').all().map(r=>r.id),['before']);
  } finally { snapshot?.close();db?.close();rmSync(dir,{recursive:true,force:true}); }
});
test('CI identity is restricted to the salon and cannot manage secrets, RBAC, storage or other apps',()=>{
  const policy=JSON.parse(readFileSync(new URL('../infra/k3s/github-deployer.json',import.meta.url)));
  assert.ok(policy.items.every(i=>i.metadata.namespace==='erdhairdesign'));
  assert.ok(!policy.items.some(i=>i.kind.startsWith('Cluster')));
  const rules=policy.items.find(i=>i.kind==='Role').rules;
  assert.deepEqual(rules.flatMap(r=>r.resources).sort(),['deployments','pods','pods/exec']);
  assert.deepEqual(rules.find(r=>r.resources.includes('deployments')).resourceNames,['erdhairdesign']);
  assert.ok(rules.every(r=>!r.verbs.includes('*')&&!r.verbs.includes('delete')));
});
test('only main pushes and manual main runs can publish/deploy; production runs are serialized',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/container.yml',import.meta.url),'utf8');
  assert.equal((workflow.match(/if: github.event_name != 'pull_request' && github.ref == 'refs\/heads\/main'/g)||[]).length,2);
  assert.match(workflow,/deploy:\n[^]*needs: publish/);
  assert.match(workflow,/name: production/);
  assert.match(workflow,/group: salon-production\n\s+cancel-in-progress: false/);
  assert.match(workflow,/secrets\.SALON_KUBECONFIG/);
  assert.match(workflow,/if: always\(\)/);
});
