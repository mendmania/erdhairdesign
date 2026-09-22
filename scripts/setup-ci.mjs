// One-time setup from an owner machine with access to the verified production API.
// Flux pulls approved release Jobs; no Kubernetes credentials leave this machine.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createDeployer } from './deploy.mjs';
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
  kubectl(['-n', 'flux-system', 'rollout', 'status', 'deployment/source-controller', '--timeout=10s']);
  kubectl(['-n', 'flux-system', 'rollout', 'status', 'deployment/kustomize-controller', '--timeout=10s']);
  const manifest = { apiVersion: 'v1', kind: 'List', items: ['github-deployer.json', 'flux-release.json'].flatMap(file => JSON.parse(readFileSync(new URL('../infra/k3s/' + file, import.meta.url))).items) };
  for (const item of manifest.items) {
    const existing = kubectl(['-n', item.metadata.namespace, 'get', item.kind, item.metadata.name, '--ignore-not-found', '-o', 'json']);
    if (existing.trim()) assert(JSON.parse(existing).metadata.labels?.['app.kubernetes.io/part-of'] === namespace, 'Refusing to replace an unowned CI resource.');
  }
  const body = JSON.stringify(manifest);
  kubectl(['apply', '--dry-run=server', '-f', '-'], body);
  kubectl(['apply', '-f', '-'], body);
  console.log(`Production pull deployments configured for ${repo}. Push to main or rerun the latest workflow.`);
  console.log('After verifying a successful release, remove the obsolete SALON_KUBECONFIG GitHub secret and its old token Secret.');
} catch (error) {
  console.error(error.status !== undefined || error.code ? 'CI setup could not complete. Check owner cluster access and GitHub environment permissions. No owner credential was uploaded; do not print provider error bodies containing tokens.' : error.message);
  process.exitCode = 1;
}
