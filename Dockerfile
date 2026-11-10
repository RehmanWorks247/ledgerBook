FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY tsconfig.json tsconfig.release.json ./
COPY apps ./apps
COPY scripts/migrate.ts scripts/release-preflight.ts scripts/release-monitor.ts scripts/database-backup.ts scripts/document-backup.ts ./scripts/
RUN npm run build && npx tsc -p tsconfig.release.json && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/apps/api/src/database/migrations ./apps/api/src/database/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:3000/api/ready',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
# Refuse startup before exposing a healthy endpoint when release guards fail.
CMD ["sh","-c","node dist/operations/scripts/release-preflight.js && exec node dist/api/main.js"]
