// Upgrade the existing salon only. CI cannot bootstrap infrastructure or read Secrets.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { expectedServer } from './deploy.mjs';

const namespace = 'erdhairdesign';
const deploymentName = namespace;
const origin = 'https://tregubio.com';
const imagePattern = /^ghcr\.io\/mendmania\/erdhairdesign@sha256:[a-f0-9]{64}$/;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

// Uses SQLite's online backup API: consistent even when bookings arrive during the backup.
// Keep private snapshots on the salon PVC, never in public GitHub Actions artifacts.
export const backupCode = `
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
const destination = process.argv[1];
if (process.env.NODE_ENV !== 'production' || process.env.APP_URL !== '${origin}' || process.arch !== 'x64') throw new Error('Unexpected salon runtime');
if (process.env.DATABASE_PATH !== '/data/salon.sqlite' || !existsSync('/data/salon.sqlite')) throw new Error('Salon database missing');
if (!/^\\/data\\/backups\\/release-[a-f0-9]{40}-[0-9]+-[0-9]+\\.sqlite$/.test(destination) || existsSync(destination)) throw new Error('Backup destination invalid or already exists');
process.umask(0o077);
mkdirSync('/data/backups', { recursive: true, mode: 0o700 });
const source = new DatabaseSync('/data/salon.sqlite', { readOnly: true });
await backup(source, destination);
source.close();
chmodSync(destination, 0o600);
const snapshot = new DatabaseSync(destination, { readOnly: true });
if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed');
snapshot.close();
console.log('Consistent database backup verified');
`;

export function validateDeployment(current) {
  assert(current.metadata?.name === deploymentName && current.metadata?.namespace === namespace && current.metadata?.labels?.['app.kubernetes.io/part-of'] === namespace, 'Deployment is not the owned salon.');
  assert(current.spec?.replicas === 1 && current.spec.strategy?.type === 'Recreate', 'Expected the single-instance SQLite deployment.');
  const containers = current.spec.template.spec.containers;
  assert(containers.length === 1 && containers[0].name === 'web' && imagePattern.test(containers[0].image), 'Unexpected salon container or registry.');
  assert(current.spec.template.spec.volumes?.some(v => v.name === 'data' && v.persistentVolumeClaim?.claimName === 'erdhairdesign-data'), 'Expected the existing salon data PVC.');
  assert(containers[0].volumeMounts?.some(v => v.name === 'data' && v.mountPath === '/data'), 'Salon data mount changed.');
  assert(current.status?.observedGeneration >= current.metadata.generation && current.status?.readyReplicas === 1 && current.status?.updatedReplicas === 1, 'The current salon rollout is not healthy.');
  return containers[0].image;
}

export function releasePatch(current, image, revision) {
  return [
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
    { op: 'test', path: '/spec/template/spec/containers/0/image', value: current.spec.template.spec.containers[0].image },
    { op: 'replace', path: '/spec/template/spec/containers/0/image', value: image },
    { op: 'add', path: '/spec/template/metadata/annotations', value: { ...current.spec.template.metadata.annotations, 'erdhairdesign/source-revision': revision } },
  ];
}

export function createReleaser(kubeconfig, run = (args, input) => execFileSync('kubectl', args, { input, encoding: 'utf8', timeout: 240000, maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })) {
  assert(kubeconfig, 'Supply an explicit production kubeconfig.');
  const call = (args, input) => run(['--kubeconfig', resolve(kubeconfig), '--request-timeout=30s', ...args], input);
  const getDeployment = () => JSON.parse(call(['-n', namespace, 'get', 'deployment', deploymentName, '-o', 'json']));
  return async function release({ image, revision, runId, attempt, assertFresh = async () => {} }) {
    assert(imagePattern.test(image), 'Use an immutable image from the salon registry.');
    assert(/^[a-f0-9]{40}$/.test(revision) && /^[0-9]+$/.test(runId) && /^[0-9]+$/.test(attempt), 'Invalid release identity.');
    const config = JSON.parse(call(['config', 'view', '--minify', '-o', 'json']));
    const cluster = config.clusters?.[0]?.cluster;
    assert(cluster?.server === expectedServer && !cluster['insecure-skip-tls-verify'] && cluster['certificate-authority-data'], 'Wrong production cluster or missing TLS verification.');
    await assertFresh();
    let current = getDeployment();
    const previousImage = validateDeployment(current);
    const pods = JSON.parse(call(['-n', namespace, 'get', 'pods', '-l', 'app.kubernetes.io/name=erdhairdesign,app.kubernetes.io/component=web', '-o', 'json'])).items;
    const pod = pods.find(p => !p.metadata.deletionTimestamp && p.spec.nodeName === 'netcupmaniaserver' && p.spec.containers?.length === 1 && p.spec.containers[0].name === 'web' && p.spec.containers[0].image === previousImage && p.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
    assert(pod, 'No healthy salon pod available for the required backup.');
    const backupPath = `/data/backups/release-${revision}-${runId}-${attempt}.sqlite`;
    const patch = (value, dry = false) => call(['-n', namespace, 'patch', 'deployment', deploymentName, '--type=json', ...(dry ? ['--dry-run=server'] : []), '--patch-file=/dev/stdin', '-o', 'name'], JSON.stringify(value));
    patch(releasePatch(current, image, revision), true);
    call(['-n', namespace, 'exec', pod.metadata.name, '-c', 'web', '--', 'node', '--input-type=module', '-e', backupCode, backupPath]);
    // Refuse to overwrite another release that completed while the snapshot was running.
    await assertFresh();
    current = getDeployment();
    assert(validateDeployment(current) === previousImage, 'The production image changed during backup; retry from the latest main.');
    patch(releasePatch(current, image, revision));
    call(['-n', namespace, 'rollout', 'status', `deployment/${deploymentName}`, '--timeout=180s']);
    const ready = getDeployment();
    assert(validateDeployment(ready) === image, 'The requested image did not become ready.');
    call(['-n', namespace, 'exec', `deployment/${deploymentName}`, '-c', 'web', '--', 'node', '--input-type=module', '-e', `for (const path of ['/health/live','/health/ready']) { const response = await fetch('http://127.0.0.1:3000' + path); if (!response.ok) throw new Error('Health check failed'); }`]);
    return { revision, image, previousImage, backupPath, url: origin };
  };
}

export async function verifyPublicRelease(expected, fetcher = fetch) {
  const response = await fetcher(`${origin}/app.js?release=${expected.revision}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert(response.ok, 'Public JavaScript is unavailable.');
  const digest = value => createHash('sha256').update(value).digest('hex');
  assert(digest(Buffer.from(await response.arrayBuffer())) === digest(expected.appJs), 'The public site is still serving different application code.');
  const bootstrap = await fetcher(`${origin}/api/bootstrap`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert(bootstrap.ok && Array.isArray((await bootstrap.json()).services), 'Public application check failed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { kubeconfig: { type: 'string' }, image: { type: 'string' }, revision: { type: 'string' }, 'run-id': { type: 'string' }, attempt: { type: 'string' } } });
    const assertFresh = async () => {
      const head = execFileSync('gh', ['api', 'repos/mendmania/erdhairdesign/git/ref/heads/main', '--jq', '.object.sha'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      assert(head === values.revision, 'A newer main commit exists; this outdated release will not deploy.');
    };
    const result = await createReleaser(values.kubeconfig)({ image: values.image, revision: values.revision, runId: values['run-id'], attempt: values.attempt, assertFresh });
    const appJs = readFileSync(new URL('../public/app.js', import.meta.url));
    let error;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { await verifyPublicRelease({ ...result, appJs }); error = null; break; } catch (e) { error = e; if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 5000)); }
    }
    if (error) throw error;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Never emit kubectl stderr, environment variables, or data from the private snapshot.
    console.error(error.status !== undefined || error.code ? 'Production command failed. Inspect the deployment with the owner kubeconfig. No automatic rollback or data restore was attempted.' : error.message);
    process.exitCode = 1;
  }
}
