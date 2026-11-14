# MegaBotTron1999's image: the shell, its connectors, the turn plugins and the web UI, with no game
# (docs/bot-os.md D49: the one image; games come as modules in the data volume).
#   docker buildx bake --load                    (docker-bake.hcl, this machine's platform)
#   docker buildx build --load -t megabottron1999 .
# Node runs the TypeScript sources directly (type stripping): the one build is the web UI's React
# app, which Vite bundles in a stage of its own, whose tools stay there (docs/bot-os.md D43).
FROM node:24.22.2-alpine AS base

# The packages' manifests, found by directory (every packages/<name>/package.json), so that a new
# package needs no line here. Copied apart from the sources so that npm's layer is cached until a
# manifest changes.
FROM base AS manifests
COPY packages/ /m/packages/
RUN find /m -type f ! -name package.json -delete && find /m -depth -type d -empty -delete

# The web UI's app, built by Vite into packages/web/dist/: React, React Flow and Vite are the web
# package's devDependencies, installed here alone (the lockfile pins them), and left behind.
FROM base AS web
WORKDIR /app
# The root's tsconfig.json too: the app's extends it.
COPY package.json package-lock.json tsconfig.json ./
COPY --from=manifests /m/ ./
RUN npm ci --workspace @megabottron1999/web --ignore-scripts --no-audit --no-fund
COPY packages/ packages/
RUN npm run build --workspace @megabottron1999/web

FROM base
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=manifests /m/ ./
# The runtime dependencies, each declared by the package that uses it: zod; grammY, its auto-retry
# and grammy-switchboard, for the Telegram bot; GramJS, for a Telegram account; the Anthropic SDK,
# for the anthropic connector; resvg, for the render service, whose native binary is a prebuilt
# optional package per platform (linux-x64-musl, linux-arm64-musl), so no install script runs.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY packages/ packages/
COPY --from=web /app/packages/web/dist/ packages/web/dist/
COPY src/ src/

# /data holds the instance's data (the event log, the plugins' stores, the modules, and from the
# next step the graph). Created here so that an empty named volume mounted on it starts out owned
# by node: Docker copies the image's directory, ownership included, into a new volume.
RUN mkdir /data && chown node:node /data
USER node

# The commit the image is built from (the Publish workflow passes it), shown with the release by
# GET /instance and the web UI's bottom bar; empty for a local build. Last, so that it spoils no
# layer's cache.
ARG BUILD_COMMIT=""
ENV BUILD_COMMIT=${BUILD_COMMIT}

ENV NODE_ENV=production LOG_DIR=/data HEALTH_PORT=8080 WEB_PORT=8082
# The shell's health endpoint (GET /health on HEALTH_PORT: 200 while every enabled connector is
# connected, 503 otherwise), and the web UI (only with its password, the web_ui_password secret),
# for a proxy or a monitor on the container's network.
EXPOSE 8080 8082
# Docker's own probe of that endpoint (busybox's wget fails on a 503). A connector takes a moment
# to connect at a start, hence the start period; with HEALTH_PORT unset there is no endpoint, so
# disable the healthcheck too (Compose's `healthcheck: disable: true`).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${HEALTH_PORT}/health" || exit 1
VOLUME ["/data"]
CMD ["node", "src/main.ts"]
