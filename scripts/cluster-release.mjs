// Runs once inside the cluster with a short-lived projected service-account token.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedServer } from './deploy.mjs';
import { createReleaser, verifyPublicRelease } from './release.mjs';

export async function assertMain(revision, fetcher = fetch) {
  const response = await fetcher('https://api.github.com/repos/mendmania/erdhairdesign/git/ref/heads/main', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'erdhairdesign-release' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || (await response.json()).object?.sha !== revision) throw new Error('Cannot verify this release is still the latest main; refusing to deploy.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = '/tmp/salon-kubeconfig.json';
  try {
    const serviceAccount = '/var/run/secrets/kubernetes.io/serviceaccount';
    if (readFileSync(`${serviceAccount}/namespace`, 'utf8') !== 'erdhairdesign') throw new Error('Unexpected namespace.');
    writeFileSync(path, JSON.stringify({ apiVersion: 'v1', kind: 'Config', 'current-context': 'salon',
      clusters: [{ name: 'salon', cluster: { server: expectedServer, 'certificate-authority-data': readFileSync(`${serviceAccount}/ca.crt`).toString('base64') } }],
      contexts: [{ name: 'salon', context: { cluster: 'salon', user: 'deployer', namespace: 'erdhairdesign' } }],
      users: [{ name: 'deployer', user: { tokenFile: `${serviceAccount}/token` } }],
    }), { mode: 0o600 });
    const revision = process.env.RELEASE_SHA;
    const result = await createReleaser(path, undefined, console.log)({
      image: process.env.RELEASE_IMAGE, revision, runId: process.env.RELEASE_RUN, attempt: process.env.RELEASE_ATTEMPT,
      assertFresh: () => assertMain(revision),
    });
    await verifyPublicRelease({ revision, appJs: readFileSync(new URL('../public/app.js', import.meta.url)) });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.status !== undefined || error.code ? 'Cluster release command failed at the last reported step. No automatic rollback was attempted.' : error.message);
    process.exitCode = 1;
  } finally { rmSync(path, { force: true }); }
}
