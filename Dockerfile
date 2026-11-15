ARG NODE_IMAGE=node:26.12.1-bookworm-slim
FROM ${NODE_IMAGE} AS tooling
ARG PNPM_VERSION=10.15.1
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
FROM tooling AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY scripts/clean-build.mjs ./scripts/clean-build.mjs
COPY src ./src
COPY resources ./resources
COPY admin-ui ./admin-ui
RUN pnpm build && pnpm prune --prod
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /app/var/storage && chown node:node /app/var/storage
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/resources ./resources
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts/healthcheck.mjs ./scripts/healthcheck.mjs
COPY --chown=node:node scripts/rag-consistency.mjs ./scripts/rag-consistency.mjs
COPY --chown=node:node scripts/release ./scripts/release
USER node
CMD ["node", "dist/entrypoints/api-server.js"]
