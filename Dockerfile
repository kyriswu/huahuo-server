ARG NODE_IMAGE=node:24.14.0-bookworm-slim
FROM ${NODE_IMAGE} AS tooling
ARG PNPM_VERSION=10.15.1
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
FROM tooling AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /app/var/storage && chown node:node /app/var/storage
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts/healthcheck.mjs ./scripts/healthcheck.mjs
USER node
CMD ["node", "dist/entrypoints/api-server.js"]
