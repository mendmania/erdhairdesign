FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node scripts/admin.mjs ./scripts/admin.mjs
RUN mkdir -p /data && chown node:node /data
USER 1000:1000

FROM base AS test
COPY --chown=node:node scripts/k3s.mjs scripts/deploy.mjs ./scripts/
COPY --chown=node:node tests/ ./tests/
RUN node --test tests/*.test.mjs

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/salon.sqlite
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
