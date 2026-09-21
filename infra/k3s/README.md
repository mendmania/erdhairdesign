# Deploy ERD beside rruge.com

## Current status

Live cluster access was verified on September 14, 2026 using the existing Netcup direct kubeconfig. The node `netcupmaniaserver` is Ready, runs K3s v1.35.7+k3s1, and uses **linux/amd64**. The shared Caddy edge has one ready replica and already has egress isolation. SSH is unavailable, but the direct Kubernetes API connection works with certificate verification.

The `erdhairdesign` namespace, non-default retained StorageClass, SQLite PVC, and default-deny policy have been created after API server dry-runs. The application is now running with one ready Pod and a bound 2Gi SQLite PVC. Both health endpoints returned HTTP 200 from inside the Pod. The dedicated email Secret is installed. The salon is publicly available at **https://tregubio.com**. Public HTTPS and the origin certificate were verified. The shared Caddy configuration was extended with only the salon route, using a new immutable ConfigMap and a resourceVersion-checked patch; existing routes and TLS volumes were retained. `rruge.com` returned HTTPS 200 after rollout.

The tested AMD64 image is published; its immutable digest and successful workflow are recorded in [`release.json`](release.json). Anonymous registry access was verified, so this release does not need an image-pull Secret. All 41 tests passed locally and inside the AMD64 CI container. Application and edge-policy manifests also passed server dry-runs; placeholder validation values were never applied. `rruge.com` still returned HTTPS 200 after the isolated foundation was created.

The selected temporary salon hostname is **tregubio.com** (managed in Cloudflare). Brevo now accepts the authorized server IP: authentication succeeded, transactional relay is enabled, and the configured sender is active. No verification email has yet been sent as a live test. The owner should register and verify their account, then use the admin-promotion command below. Configure real salon services, shifts, prices, and off-node database backups before taking client bookings. The application uses `/`, so choose a hostname rather than a subpath such as `rruge.com/salon`.

## Automatic production releases

The `Test, publish and deploy salon` workflow now runs tests, publishes an immutable AMD64 image, and upgrades **only the existing salon deployment** after every push to `main`. Pull requests only test/build. **Run workflow** on `main` can retry a release. Publishing an image alone is not a successful deployment: the production job must also pass.

One-time activation (run from an owner machine that can reach the verified Kubernetes API):

```sh
node scripts/setup-ci.mjs --kubeconfig /path/to/netcup-k3s-admin-direct.yaml
```

The setup verifies the cluster and existing salon, creates the scoped identity defined in `github-deployer.json`, and stores **only that identity** as `SALON_KUBECONFIG` in this repository's **production** environment. The owner kubeconfig is never uploaded. The environment is limited to the `main` branch; existing environment protections are preserved. No GitHub approval gate is added. Both an authenticated `gh` CLI with repository administration access and the owner kubeconfig are needed for this one-time operation.

The deployment identity can get/watch/patch the named salon Deployment, inspect salon-namespace pods, and execute the database-backup and health-check commands there. It cannot read Kubernetes Secret objects, change RBAC, delete storage, or manage the shared edge or other namespaces. Deployment/exec access is still production access: restrict who can push or merge workflow changes to `main`. This external runner uses a dedicated persistent service-account token, which can be revoked by deleting the token Secret printed by setup. Rotate it by rerunning setup, confirming a successful deployment, and then deleting the old token Secret. [Kubernetes documents this token mechanism and recommends short-lived tokens where supported](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/); this setup does not change the shared API server to add an OIDC provider.

GitHub-hosted runners must be able to reach the verified API at `https://159.195.30.113:6443`. If the endpoint is accessible only through a private network, arrange an approved runner/network connection before enabling deployment; do not disable TLS verification. The deployment job fails explicitly if its credential is missing. **As of this change, the saved API address timed out from the development machine and the saved SSH identity was rejected, so live credential provisioning and a production rollout could not be verified.** Run setup once access is restored, then re-run the latest `main` workflow.

Each upgrade:

1. Rejects stale `main` commits, wrong clusters, unhealthy starting deployments, unexpected containers, or changed storage.
2. Server-dry-runs an update to the image and source-revision annotation, preserving all other live configuration.
3. Uses SQLite's online backup API inside the running salon pod, validates the snapshot, and saves it privately at `/data/backups/release-COMMIT-RUN-ATTEMPT.sqlite` with owner-only permissions. A backup failure prevents the upgrade.
4. Rechecks the latest source and current deployment before applying a resource-version-guarded patch. Production jobs are serialized and an in-progress deployment is not cancelled by a newer push.
5. Waits for rollout and internal health checks, then compares the public `/app.js` with the exact checkout and checks `/api/bootstrap` at `https://tregubio.com`.

There is a short salon interruption with the existing single-instance Recreate strategy. No edge/DNS changes, Secret changes, automatic image rollback, or automatic database restoration happen during release. The workflow summary records the deployed and previous image digests plus the backup path. Snapshots remain on the current PVC; they are not off-node disaster recovery and are never uploaded as public workflow artifacts. Monitor disk usage and archive/prune reviewed old snapshots as part of the backup routine.

The main-branch environment restriction follows [GitHub's deployment-environment controls](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Repeatable deployment commands

The checked-in helper always requires an explicit kubeconfig and verifies the API server, node identity, AMD64 architecture, edge labels/readiness, storage provisioner, and existing edge egress isolation. It rejects resource-name collisions with other owners, validates manifests with the API server before applying them, and waits for app readiness. It does not modify shared Caddy routes, DNS, Secrets, or existing booking data. Run it from the repository with Node 22.16+ and kubectl installed.

```sh
export SALON_KUBECONFIG=/secure/path/to/netcup-k3s-admin-direct.yaml
npm run k3s -- check --kubeconfig "$SALON_KUBECONFIG"
# Already completed on the verified cluster; safe to repeat for owned resources.
npm run k3s -- bootstrap --kubeconfig "$SALON_KUBECONFIG"
```

The workflow tests pull requests and automatically publishes/deploys successful `main` pushes after the one-time setup above. The publishing job uses its short-lived GitHub token and pinned action revisions, without changing package visibility. `release.json` records an earlier manual release; the latest successful production workflow summary is the source of truth for automatic releases.

Using the selected hostname and published digest, generate a new release directory (existing directories are never overwritten):

```sh
export SALON_HOSTNAME=tregubio.com
export SALON_IMAGE=ghcr.io/mendmania/erdhairdesign@sha256:ACTUAL_DIGEST
npm run k3s -- plan --kubeconfig "$SALON_KUBECONFIG" \
  --hostname "$SALON_HOSTNAME" --image "$SALON_IMAGE" \
  --cloudflare --output .runtime/k3s/release-001
```

Create the dedicated email and optional registry Secrets using section 3 below. The email Secret must contain **only** `BREVO_API_KEY` and `EMAIL_FROM`, preventing overrides of production settings. Then validate and roll out the private app:

```sh
npm run k3s -- deploy --kubeconfig "$SALON_KUBECONFIG" \
  --hostname "$SALON_HOSTNAME" --image "$SALON_IMAGE" \
  --dry-run
npm run k3s -- deploy --kubeconfig "$SALON_KUBECONFIG" \
  --hostname "$SALON_HOSTNAME" --image "$SALON_IMAGE"
```

Omit `--pull-secret` only for an image accessible without authentication. A successful rollout means the app is ready **inside the cluster**. Complete the shared edge/DNS steps below and verify HTTPS/email before announcing it publicly. Before an upgrade, take a consistent database backup; the helper never performs an automatic data rollback.

The existing platform uses `mendim@159.195.30.113`, the remote owner kubeconfig `/home/mendim/.kube/readyski-beta-direct.yaml`, and the shared edge `edge-caddy/edge-caddy`. Its live configuration is an immutable ConfigMap mounted with subPath and `admin off`, so the cutover must preserve the latest configuration and account for a brief shared-edge restart. Platform source management remains in `/home/mendim/ops`.

## Deployment layout

The offline renderer `scripts/k3s.mjs` generates ordinary Kubernetes JSON, accepted by kubectl. It never contacts a cluster or applies changes itself.

- Separate `erdhairdesign` namespace with restricted Pod Security.
- One non-root, read-only-root Deployment using `Recreate`, with bounded resources and graceful SIGTERM handling. Upgrades have a short salon-only interruption.
- A 2Gi requested SQLite PVC using the new, **non-default** `erdhairdesign-local-retain` StorageClass. The default cluster StorageClass is untouched. Retain protects against accidental volume reclamation; it is not a backup. Local-path requested sizes are not hard filesystem quotas.
- Internal ClusterIP Service on port 3000. No host ports, NodePort, LoadBalancer, Ingress, new ingress controller, or public database.
- HTTP liveness and database readiness probes, independent of Brevo and client rate limits.
- Default-deny network policy, CoreDNS access, and public IPv4 HTTPS egress for Brevo. HTTPS egress is not limited to a Brevo FQDN; standard NetworkPolicy cannot express FQDN rules. Private IPv4 ranges are excluded.
- App ingress accepts only the documented shared edge pods. A separate additive edge policy allows those pods to reach this app on 3000.
- `TRUST_PROXY=true` trusts only the `X-Erd-Client-IP` value that the supplied Caddy block overwrites. Keep it paired with ingress isolation. A direct/public app listener must leave this setting false.
- Runtime email credentials are referenced from a dedicated Kubernetes Secret, never embedded in the image or rendered manifests.

SQLite requires a single replica and a persistent disk on this initial deployment. Do not add an HPA or multiple replicas. A node loss can lose availability and local storage; arrange consistent encrypted off-node backups before taking real bookings.

## 1. Build a tested image (manual alternative)

From a machine with a running Docker engine:

```sh
npm run check
npm test
docker build --target test -t erdhairdesign:test .
docker build --target runtime -t erdhairdesign:local .
```

The official Node 22 base is pinned to a multiarchitecture digest. `.dockerignore` uses an allowlist that excludes `.env`, local data, runtime files, and Git history. The final runtime stage excludes tests.

Publish an image for the actual node architecture using the project's own registry authorization; `ghcr.io/mendmania/erdhairdesign` corresponds to this repository. Use a unique release tag and record its immutable digest. Building on this Mac defaults to ARM64; verify the VPS architecture or publish both architectures with buildx. Do not reuse Rrugë's deployment image or change its package visibility. The workflow run summary is the release source of truth after publication.

For manual publication after obtaining registry access:

```sh
docker buildx build --platform linux/amd64 --target runtime \
  --tag "ghcr.io/mendmania/erdhairdesign:$SALON_RELEASE" --push .
```

Set `SALON_IMAGE` to the resulting `ghcr.io/mendmania/erdhairdesign@sha256:...` digest. The manifest renderer rejects mutable image tags. For a private image, create a dedicated image-pull Secret in the salon namespace from an authorized read-only registry config. The release currently recorded in `release.json` was verified anonymously accessible and needs no pull Secret. Do not print credentials or assume another application's pull credential is authorized for this package.

## 2. Select the correct cluster and render

Use the actual authorized kubeconfig and selected hostname:

```sh
export SALON_KUBECONFIG=/secure/path/to/the-rruge-cluster.yaml
export SALON_HOSTNAME=tregubio.com
export SALON_IMAGE=ghcr.io/mendmania/erdhairdesign@sha256:ACTUAL_DIGEST

salon_kubectl() { kubectl --kubeconfig "$SALON_KUBECONFIG" "$@"; }
salon_kubectl get nodes -o wide
salon_kubectl -n edge-caddy get deployment edge-caddy
salon_kubectl get storageclass
```

On the VPS, use its documented owner kubeconfig after confirming identity and access. Verify the node, shared edge labels, existing policies, storage provisioner, capacity, and current platform inventory. Do not continue if these differ unexpectedly.

```sh
mkdir -p .runtime/k3s
node scripts/k3s.mjs foundation > .runtime/k3s/foundation.json
node scripts/k3s.mjs app --hostname "$SALON_HOSTNAME" --image "$SALON_IMAGE" \
  --pull-secret erdhairdesign-registry > .runtime/k3s/app.json
node scripts/k3s.mjs edge-policy > .runtime/k3s/edge-policy.json
node scripts/k3s.mjs caddy --hostname "$SALON_HOSTNAME" --cloudflare > .runtime/k3s/Caddyfile.salon
```

Omit `--pull-secret` only if the selected image is intentionally accessible without it. The renderer does not change package permissions.

## 3. Create only salon infrastructure and credentials

Inspect existing resources with the same names before the first apply. Stop if any belong to another installation. For initial installation, server-dry-run and then apply the Namespace and StorageClass from the foundation file first, followed by a dry-run and apply of the full foundation file. Kubernetes cannot validate a namespaced resource against a namespace that does not yet exist. For example, generate the first stage without contacting the cluster:

```sh
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const manifest = JSON.parse(readFileSync(".runtime/k3s/foundation.json", "utf8"));
  manifest.items = manifest.items.filter(r => !r.metadata.namespace);
  console.log(JSON.stringify(manifest));
' > .runtime/k3s/cluster-resources.json

salon_kubectl apply --dry-run=server -f .runtime/k3s/cluster-resources.json
salon_kubectl apply -f .runtime/k3s/cluster-resources.json
salon_kubectl apply --dry-run=server -f .runtime/k3s/foundation.json
salon_kubectl apply -f .runtime/k3s/foundation.json
```

Create an owner-only file outside Git with **only** these keys:

```dotenv
BREVO_API_KEY=your_actual_brevo_api_key
EMAIL_FROM=ERD Hair Design <your-verified-sender@your-domain.com>
```

Create the dedicated Secret without placing its values in command arguments or output:

```sh
salon_kubectl -n erdhairdesign create secret generic erdhairdesign-email \
  --from-env-file=/secure/path/to/erdhairdesign-email.env
salon_kubectl -n erdhairdesign create secret generic erdhairdesign-registry \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/secure/path/to/authorized-registry-config.json
```

If either Secret already exists, inspect ownership and retain it; do not blindly overwrite it. The production app deliberately requires a real configured email provider. Do not deploy local test codes, fake credentials, or development mode to work around missing Brevo setup.

## 4. Roll out the app privately

```sh
salon_kubectl apply --dry-run=server -f .runtime/k3s/app.json
salon_kubectl apply -f .runtime/k3s/app.json
salon_kubectl -n erdhairdesign rollout status deployment/erdhairdesign --timeout=180s
salon_kubectl -n erdhairdesign get pods,pvc,service
salon_kubectl -n erdhairdesign port-forward --address 127.0.0.1 service/erdhairdesign 3420:3000
```

Check `/health/live`, `/health/ready`, and `/` on the loopback forward. Production cookies are Secure; complete the real registration and booking smoke test through the final HTTPS origin, not plain HTTP. A rollout failure is not success: inspect its cause and retain storage. Do not reset the database or fall back to development configuration.

## 5. Add the salon hostname through the existing edge

1. Inspect the live shared Caddy configuration and platform `/home/mendim/ops` checkout. Register this app in that platform's current inventory if required by its operating process.
2. Back up the current shared configuration and TLS state privately. Confirm existing hosts such as `rruge.com` are healthy before changes.
3. Validate and apply only `.runtime/k3s/edge-policy.json`; this adds a salon-only egress allowance in the edge namespace. Keep all existing policies.
4. Merge `Caddyfile.salon` into the **latest** shared configuration using the existing edge controller. Refuse an already-owned hostname. Validate the complete merged Caddy configuration before switching to it. Preserve every other hostname and shared settings.
5. The documented edge has `admin off`, a subPath config mount, and Recreate rollouts. Respect its actual controller and resourceVersion to avoid overwriting concurrent changes; changing it may briefly affect all routed sites. Never replace the whole shared deployment using a stale example.
6. Point the chosen hostname's DNS to the verified server address, preserve unrelated records, and verify HTTPS using normal certificate validation. The reference VPS address is `159.195.30.113`; recheck before setting DNS. Add `www` only if explicitly desired and its DNS/TLS are also ready.
7. Confirm `rruge.com` and the other existing hosts remain healthy. Test the salon's sign-up, Brevo email, verification, request, and admin approval through its new origin.

The candidate uses Let's Encrypt through the existing Caddy edge and hides public health routes. It does not install Traefik/cert-manager, bind ports 80/443, modify DNS, or apply shared configuration automatically. For this Cloudflare-proxied domain, `--cloudflare` trusts CF-Connecting-IP only when the connecting address matches Cloudflare's official IPv4/IPv6 ranges (verified September 14, 2026), otherwise using the direct remote address. The applied salon block is recorded in `Caddyfile.tregubio`. The active ConfigMap is `erdhairdesign-edge-497262a88fcc`; its predecessor `erdhairdesign-edge-5d58ba402184` and the pre-salon `edge-caddy-trade-removed-bfa774f3e0` remain available. Re-read the live deployment before any rollback, and change only its Caddyfile volume reference after a resourceVersion check. Never restore an entire old shared Deployment. Full local before/candidate snapshots remain under the ignored `.runtime/k3s/edge-tregubio` directory.

## Admin setup, upgrades, and recovery

After registering and verifying the owner's email on the salon domain:

```sh
salon_kubectl -n erdhairdesign exec deployment/erdhairdesign -- \
  node scripts/admin.mjs owner@example.com
```

Replace the address with the actual owner. The command promotes only an existing verified account. There is no shared default admin login.

For upgrades, record the current image digest and take a consistent SQLite snapshot using the SQLite online backup API or a stopped-writer snapshot including the database and WAL. Copying only `salon.sqlite` while it is being written is not a consistent backup. Arrange encrypted off-node storage and rehearse a restore to a separate volume before real bookings.

Render the app manifest with the new tested digest and the existing approved hostname. Preserve live settings, Secrets and PVC; the application settings are stored inside SQLite. Dry-run, review, apply the scoped application changes, and check rollout/readiness. A Secret rotation requires a salon deployment restart; it does not require changing the shared edge.

Only roll back to an image compatible with the current database schema. Never restore an old database over new client bookings automatically. Do not delete the namespace/PVC or change cluster-wide storage defaults as a rollback step.

References: [Kubernetes persistent volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/), [K3s image import](https://docs.k3s.io/add-ons/import-images), and the adjacent Rrugë `infra/kubernetes/README.md` and `DOMAIN.md` runbooks.
