FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm test && npm run build

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production BRIDGE_DATA_DIR=/data BRIDGE_HOST=0.0.0.0 BRIDGE_EXECUTION=disabled
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p /data /projects && chown node:node /data /projects
COPY --from=build /app/dist ./dist
COPY --from=build /app/knowledge ./knowledge
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
