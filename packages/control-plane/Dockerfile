FROM alpine AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apk add libgcc libstdc++ ripgrep

FROM base AS build-amd64
COPY dist/control-plane-linux-x64-baseline-musl/bin/control-plane /usr/local/bin/control-plane

FROM base AS build-arm64
COPY dist/control-plane-linux-arm64-musl/bin/control-plane /usr/local/bin/control-plane

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN control-plane --version
ENTRYPOINT ["control-plane"]
