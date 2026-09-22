FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node scripts/admin.mjs ./scripts/admin.mjs
RUN mkdir -p /data && chown node:node /data
ARG SOURCE_REVISION=unknown
ARG SOURCE_RELEASE=unknown
ENV APP_REVISION=$SOURCE_REVISION APP_RELEASE=$SOURCE_RELEASE
USER 1000:1000

FROM base AS test
COPY --chown=node:node scripts/k3s.mjs scripts/deploy.mjs scripts/release.mjs scripts/gitops.mjs scripts/cluster-release.mjs ./scripts/
COPY --chown=node:node tests/ ./tests/
COPY --chown=node:node infra/k3s/github-deployer.json infra/k3s/flux-release.json ./infra/k3s/
COPY --chown=node:node .github/workflows/container.yml ./.github/workflows/container.yml
RUN node --test tests/*.test.mjs

FROM base AS deployer
COPY --chown=node:node scripts/deploy.mjs scripts/release.mjs scripts/cluster-release.mjs ./scripts/
COPY --chmod=0755 .runtime/ci/kubectl /usr/local/bin/kubectl
ENV HOME=/tmp
CMD ["node", "scripts/cluster-release.mjs"]

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/salon.sqlite
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
