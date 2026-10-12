# 蓝图；P01须提供真实package/lock/src/migrations与build复制资源逻辑。
# 只构建独立后端。不要COPY huahuo-app或运行时git clone。
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS tooling
ARG PNPM_VERSION
RUN test -n "$PNPM_VERSION" && npm install -g "pnpm@$PNPM_VERSION"
WORKDIR /app
# 可选工具镜像：主机缺Node/pnpm时使用；只挂载Server，绝不挂Code或App。
FROM tooling AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
# build必须把src/admin-ui的模板/静态资源复制到dist，且entrypoint路径与Compose一致。
RUN pnpm build && pnpm prune --prod

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /app/var/storage && chown -R node:node /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/scripts ./scripts
USER node
CMD ["node", "dist/entrypoints/api-server.js"]
