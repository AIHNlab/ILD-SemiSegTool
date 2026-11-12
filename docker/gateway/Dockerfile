# Stage 1: build the OHIF viewer (with the monai-label extension) from source.
FROM docker.io/library/node:20-bullseye AS ohif
WORKDIR /viewers
RUN corepack enable
COPY viewer/ ./
RUN yarn config set workspaces-experimental true \
 && yarn install --frozen-lockfile --network-timeout 600000 \
 && cd platform/app \
 && NODE_ENV=production APP_CONFIG=config/monai_label.js PUBLIC_URL=/ohif/ QUICK_BUILD=true yarn run build

# Stage 2: Caddy serves the built viewer and routes everything else.
FROM docker.io/library/caddy:2.10-alpine
COPY --from=ohif /viewers/platform/app/dist /srv/ohif
# A version on app-config.js's URL (index.html), new on every build: browsers
# that cached the file before the gateway sent Cache-Control (see Caddyfile)
# would otherwise keep using that old copy.
RUN sed -i "s#/ohif/app-config.js\"#/ohif/app-config.js?v=$(date +%s)\"#" /srv/ohif/index.html \
 && grep -q 'app-config.js?v=' /srv/ohif/index.html
COPY docker/gateway/Caddyfile /etc/caddy/Caddyfile
