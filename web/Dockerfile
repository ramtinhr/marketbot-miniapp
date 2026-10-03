FROM node:22-alpine AS build

WORKDIR /app
# Built from the repository root (the npm workspace and its lockfile live there).
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci -w web
COPY web web
ARG VITE_BOT_USERNAME=
ENV VITE_BOT_USERNAME=${VITE_BOT_USERNAME}
RUN npm run build -w web

FROM nginx:1.28-alpine
# The official image renders /etc/nginx/templates/*.template with envsubst at
# start, substituting only variables that are set - nginx's own $host etc. stay.
ENV API_UPSTREAM=http://127.0.0.1:8090 \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=80
COPY web/deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${WEB_PORT}/healthz" >/dev/null || exit 1
