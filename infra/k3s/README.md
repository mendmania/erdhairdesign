# Deploy ERD beside rruge.com

## Current status

Live cluster access was verified on September 14, 2026 using the existing Netcup direct kubeconfig. The node `netcupmaniaserver` is Ready, runs K3s v1.35.7+k3s1, and uses **linux/amd64**. The shared Caddy edge has one ready replica and already has egress isolation. SSH is unavailable, but the direct Kubernetes API connection works with certificate verification.

The `erdhairdesign` namespace, non-default retained StorageClass, SQLite PVC, and default-deny policy have been created after API server dry-runs. The PVC waits for its first consuming Pod before provisioning; Pending is expected before the app is deployed. No application Pod or public salon route is running yet. No existing site's edge configuration was changed.

The tested AMD64 image is published; its immutable digest and successful workflow are recorded in [`release.json`](release.json). Anonymous registry access was verified, so this release does not need an image-pull Secret. All 41 tests passed locally and inside the AMD64 CI container. Application and edge-policy manifests also passed server dry-runs; placeholder validation values were never applied. `rruge.com` still returned HTTPS 200 after the isolated foundation was created.

Still needed for public launch: the salon hostname and Brevo API key with a verified sender. The application uses `/`, so choose a hostname rather than a subpath such as `rruge.com/salon`.

## Repeatable deployment commands

The checked-in helper always requires an explicit kubeconfig and verifies the API server, node identity, AMD64 architecture, edge labels/readiness, storage provisioner, and existing edge egress isolation. It rejects resource-name collisions with other owners, validates manifests with the API server before applying them, and waits for app readiness. It does not modify shared Caddy routes, DNS, Secrets, or existing booking data. Run it from the repository with Node 22.16+ and kubectl installed.

```sh
export SALON_KUBECONFIG=/secure/path/to/netcup-k3s-admin-direct.yaml
npm run k3s -- check --kubeconfig "$SALON_KUBECONFIG"
# Already completed on the verified cluster; safe to repeat for owned resources.
npm run k3s -- bootstrap --kubeconfig "$SALON_KUBECONFIG"
```

`.github/workflows/container.yml` tests the application and builds the runtime image for pull requests and main pushes. Run **Test and publish salon image** manually on `main` to publish the tested AMD64 image to this repository's GHCR package. The job uses its short-lived GitHub token, pinned action revisions, and records an immutable image digest in the run summary. It does not grant GitHub cluster access or change package visibility. The first publication completed successfully; see `release.json` for the tested source commit, image digest, and workflow URL.

After selecting the hostname and the published digest, generate a new release directory (existing directories are never overwritten):

```sh
export SALON_HOSTNAME=your-actual-salon-domain.com
export SALON_IMAGE=ghcr.io/mendmania/erdhairdesign@sha256:ACTUAL_DIGEST
npm run k3s -- plan --kubeconfig "$SALON_KUBECONFIG" \
  --hostname "$SALON_HOSTNAME" --image "$SALON_IMAGE" \
  --output .runtime/k3s/release-001
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
export SALON_HOSTNAME=your-actual-salon-domain.com
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
node scripts/k3s.mjs caddy --hostname "$SALON_HOSTNAME" > .runtime/k3s/Caddyfile.salon
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

The candidate uses Let's Encrypt through the existing Caddy edge and hides public health routes. It does not install Traefik/cert-manager, bind ports 80/443, modify DNS, or apply shared configuration automatically. When placed behind an additional CDN, revisit trusted client-IP handling with the actual proxy chain instead of trusting arbitrary forwarding headers.

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
