FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm_config_nodedir=/usr/local npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY shared ./shared
COPY migrations ./migrations
COPY public ./public
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
RUN apt-get update && apt-get install -y --no-install-recommends gosu ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production APP_MODE=real HOST=0.0.0.0 PORT=3001 DATA_DIR=/app/data LOCAL_TEST_NO_PASSWORD=false LOCAL_TEST_NO_RATE_LIMIT=false
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir /app/data && chown node:node /app/data
COPY deploy/synology/entrypoint.sh /usr/local/bin/jorik-entrypoint
RUN chmod 755 /usr/local/bin/jorik-entrypoint
ENTRYPOINT ["/usr/local/bin/jorik-entrypoint"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/auth-status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist-server/server/index.js"]
