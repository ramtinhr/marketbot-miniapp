FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
# Built from the repository root (the npm workspace and its lockfile live there).
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci -w server --omit=dev
COPY server/src server/src

WORKDIR /app/server
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT:-8090}/health" >/dev/null || exit 1
CMD ["node", "src/server.js"]
