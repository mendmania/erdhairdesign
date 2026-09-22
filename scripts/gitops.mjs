// GitHub only publishes a release request. Flux runs it privately inside Kubernetes.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPublicRelease } from './release.mjs';

const repo = 'mendmania/erdhairdesign';
const branch = 'salon-production';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export function releaseJob({ image, deployerImage, revision, runId, attempt }) {
  const immutable = /^ghcr\.io\/mendmania\/erdhairdesign@sha256:[a-f0-9]{64}$/;
  assert(immutable.test(image) && immutable.test(deployerImage), 'Both release images must be pinned to salon registry digests.');
  assert(/^[a-f0-9]{40}$/.test(revision) && /^[0-9]{1,20}$/.test(runId) && /^[0-9]{1,5}$/.test(attempt), 'Invalid release identity.');
  return { apiVersion: 'batch/v1', kind: 'Job', metadata: {
    name: `salon-release-${runId}-${attempt}`, namespace: 'erdhairdesign', labels: { 'app.kubernetes.io/part-of': 'erdhairdesign' },
  }, spec: { backoffLimit: 0, activeDeadlineSeconds: 480, template: {
    metadata: { labels: { 'app.kubernetes.io/name': 'salon-release' } },
    spec: { serviceAccountName: 'github-deployer', automountServiceAccountToken: true, restartPolicy: 'Never',
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'release', image: deployerImage, imagePullPolicy: 'IfNotPresent',
        env: Object.entries({ RELEASE_IMAGE: image, RELEASE_SHA: revision, RELEASE_RUN: runId, RELEASE_ATTEMPT: attempt }).map(([name, value]) => ({ name, value })),
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
        volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
      }], volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '32Mi' } }],
    },
  } } };
}

export async function verifyRevision(revision, release, fetcher = fetch) {
  const response = await fetcher(`https://tregubio.com/api/version?release=${revision}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert(response.ok, 'Production release identity is unavailable.');
  const actual = await response.json();
  assert(actual.revision === revision && actual.release === release, 'Production has not activated this release attempt yet.');
}

export async function publishRequest(options, api) {
  const job = releaseJob(options);
  const fresh = async () => assert((await api('GET', `/git/ref/heads/main`)).object.sha === options.revision, 'A newer main commit exists; refusing to publish a stale release.');
  await fresh();
  // List refs instead of treating every 404/network failure as an absent branch.
  const refs = await api('GET', `/git/matching-refs/heads/${branch}`);
  const parent = refs.find(ref => ref.ref === `refs/heads/${branch}`)?.object.sha;
  const files = { 'release.json': JSON.stringify(job, null, 2), 'kustomization.yaml': 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - release.json\n' };
  const tree = [];
  for (const [path, content] of Object.entries(files)) {
    const blob = await api('POST', '/git/blobs', { content, encoding: 'utf-8' });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const createdTree = await api('POST', '/git/trees', { tree });
  const commit = await api('POST', '/git/commits', { message: `Deploy ${options.revision} (run ${options.runId}, attempt ${options.attempt})`, tree: createdTree.sha, parents: parent ? [parent] : [] });
  await fresh();
  if (parent) await api('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
  else await api('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
  return { revision: options.revision, image: options.image, job: job.metadata.name, releaseCommit: commit.sha };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const api = async (method, path, body) => JSON.parse(execFileSync('gh', ['api', '--method', method, `repos/${repo}${path}`, ...(body ? ['--input', '-'] : [])], { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    const options = { image: process.env.RELEASE_IMAGE, deployerImage: process.env.DEPLOYER_IMAGE, revision: process.env.RELEASE_SHA, runId: process.env.RELEASE_RUN, attempt: process.env.RELEASE_ATTEMPT };
    const result = await publishRequest(options, api);
    console.log(JSON.stringify(result, null, 2));
    console.log('Release queued. Waiting for Flux, database backup, rollout and public verification.');
    const deadline = Date.now() + 600000;
    let lastError;
    while (Date.now() < deadline) {
      try {
        await verifyRevision(options.revision, `${options.runId}-${options.attempt}`);
        await verifyPublicRelease({ revision: options.revision, appJs: readFileSync(new URL('../public/app.js', import.meta.url)) });
        console.log(`Production verified: https://tregubio.com (${options.revision})`);
        process.exit(0);
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    throw new Error(`Production verification timed out: ${lastError.message} Inspect Job erdhairdesign/${result.job}.`);
  } catch (error) { console.error(error.status !== undefined ? 'Publishing the release request failed; check GitHub contents permissions.' : error.message); process.exitCode = 1; }
}
