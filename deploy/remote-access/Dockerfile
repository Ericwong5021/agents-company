FROM oven/bun:1.3.14 AS bun

FROM node:24-bookworm-slim AS dependencies
WORKDIR /workspace
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS webui-build
ENV AGENT_COMPANY_WEBUI_DATA_DIR=/data
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN bun run --cwd packages/app build

FROM dependencies AS relay-build
RUN bun build packages/relay/src/index.ts --target=bun --outfile=/workspace/relay.js

FROM node:24-bookworm-slim AS webui
WORKDIR /app
ENV NODE_ENV=production
COPY --from=webui-build /workspace/packages/app/.output .
CMD ["sh", "-c", "mkdir -p /data/db && node server/index.mjs"]

FROM oven/bun:1.3.14-slim AS relay
WORKDIR /app
COPY --from=relay-build /workspace/relay.js ./relay.js
CMD ["bun", "relay.js"]
