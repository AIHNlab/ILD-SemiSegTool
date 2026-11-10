# Stage 1: build the OHIF viewer (with the monai-label extension) from source.
FROM node:20-bullseye AS ohif
WORKDIR /viewers
RUN corepack enable
COPY viewer/ ./
RUN yarn config set workspaces-experimental true \
 && yarn install --frozen-lockfile --network-timeout 600000 \
 && cd platform/app \
 && NODE_ENV=production APP_CONFIG=config/monai_label.js PUBLIC_URL=/ohif/ QUICK_BUILD=true yarn run build

# Stage 2: Caddy serves the built viewer and routes everything else.
FROM caddy:2.10-alpine
COPY --from=ohif /viewers/platform/app/dist /srv/ohif
COPY docker/gateway/Caddyfile /etc/caddy/Caddyfile
