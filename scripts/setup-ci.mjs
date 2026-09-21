// One-time setup from an owner machine with access to the verified production API.
// The owner kubeconfig never leaves this machine; only a salon-scoped identity goes to GitHub.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createDeployer, expectedServer } from './deploy.mjs';
import { validateDeployment } from './release.mjs';

const repo = 'mendmania/erdhairdesign';
const namespace = 'erdhairdesign';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const run = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
try {
  const { values } = parseArgs({ options: { kubeconfig: { type: 'string' } } });
  assert(values.kubeconfig, 'Usage: node scripts/setup-ci.mjs --kubeconfig /path/to/owner-kubeconfig');
  const path = resolve(values.kubeconfig);
  const kubectl = (args, input) => run('kubectl', ['--kubeconfig', path, '--request-timeout=10s', ...args], input);
  createDeployer(path, args => run('kubectl', args)).check();
  validateDeployment(JSON.parse(kubectl(['-n', namespace, 'get', 'deployment', namespace, '-o', 'json'])));
  const gh = (args, input) => run('gh', args, input);
  const endpoint = `repos/${repo}/environments/production`;
  const environments = JSON.parse(gh(['api', `repos/${repo}/environments`])).environments;
  if (!environments.some(e => e.name === 'production')) {
    gh(['api', '--method', 'PUT', endpoint, '--input', '-'], JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }));
    gh(['api', '--method', 'POST', `${endpoint}/deployment-branch-policies`, '--input', '-'], JSON.stringify({ name: 'main', type: 'branch' }));
  } else {
    const environment = JSON.parse(gh(['api', endpoint]));
    const policies = JSON.parse(gh(['api', `${endpoint}/deployment-branch-policies`])).branch_policies;
    assert(environment.deployment_branch_policy?.custom_branch_policies && policies.length === 1 && policies[0].name === 'main' && policies[0].type === 'branch', 'Configure the existing production environment to allow only the main branch, then retry. Existing protections were preserved.');
  }
  const manifest = JSON.parse(readFileSync(new URL('../infra/k3s/github-deployer.json', import.meta.url)));
  for (const item of manifest.items) {
    const existing = kubectl(['-n', namespace, 'get', item.kind, item.metadata.name, '--ignore-not-found', '-o', 'json']);
    if (existing.trim()) assert(JSON.parse(existing).metadata.labels?.['app.kubernetes.io/part-of'] === namespace, 'Refusing to replace an unowned CI resource.');
  }
  const body = JSON.stringify(manifest);
  kubectl(['apply', '--dry-run=server', '-f', '-'], body);
  kubectl(['apply', '-f', '-'], body);
  const secretName = 'github-deployer-token-' + randomUUID().slice(0, 8);
  kubectl(['create', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace, labels: { 'app.kubernetes.io/part-of': namespace }, annotations: { 'kubernetes.io/service-account.name': 'github-deployer' } }, type: 'kubernetes.io/service-account-token' }));
  let data;
  for (let attempt = 0; attempt < 10; attempt++) {
    data = JSON.parse(kubectl(['-n', namespace, 'get', 'secret', secretName, '-o', 'json'])).data;
    if (data?.token && data['ca.crt']) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(data?.token && data['ca.crt'], 'The deployment token is not ready. No credential was uploaded.');
  const kubeconfig = JSON.stringify({ apiVersion: 'v1', kind: 'Config', 'current-context': 'salon-production', clusters: [{ name: 'salon', cluster: { server: expectedServer, 'certificate-authority-data': data['ca.crt'] } }], contexts: [{ name: 'salon-production', context: { cluster: 'salon', user: 'github-deployer', namespace } }], users: [{ name: 'github-deployer', user: { token: Buffer.from(data.token, 'base64').toString() } }] });
  gh(['secret', 'set', 'SALON_KUBECONFIG', '--repo', repo, '--env', 'production'], kubeconfig);
  console.log(`Production CI configured for ${repo}, main only. Token reference: ${namespace}/${secretName}.`);
  console.log('Re-run the latest main workflow to deploy. Revoke older github-deployer token Secrets after confirming a successful rotation.');
} catch (error) {
  console.error(error.status !== undefined || error.code ? 'CI setup could not complete. Check owner cluster access and GitHub environment permissions. No owner credential was uploaded; do not print provider error bodies containing tokens.' : error.message);
  process.exitCode = 1;
}
