#!/usr/bin/env bash
set -euo pipefail

repository="Ericwong5021/agents-company"
release_download="https://github.com/$repository/releases/download"
signer_workflow="$repository/.github/workflows/preview.yml"
action="${1:-}"
provider="${2:-}"
target="${3:-}"
directory="${AGENT_COMPANY_SELFHOST_DIR:-/opt/agent-company-remote}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

retry() {
  local attempt=1
  until "$@"; do
    [ "$attempt" -ge 3 ] && return 1
    attempt=$((attempt + 1))
    sleep "$attempt"
  done
}

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$1" | awk '{print $1}'
}

release_asset() {
  retry curl -fsSL --connect-timeout 15 --max-time 300 --retry 2 "$release_download/$target/$1" -o "$2"
}

verify_attestation() {
  gh attestation verify "$1" --repo "$repository" --signer-workflow "$signer_workflow" --source-ref "refs/tags/$target" >/dev/null
}

verify_checksum() {
  local expected
  expected="$(awk -v asset="$(basename "$1")" '$2 == asset { print $1 }' "$2")"
  [ -n "$expected" ] || fail "release checksum missing for $(basename "$1")"
  [ "$(digest "$1")" = "$expected" ] || fail "release checksum mismatch for $(basename "$1")"
}

validate_remote_environment() {
  grep -Eq '^AGENT_COMPANY_RELEASE=v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' "$1" || fail "invalid release environment"
  grep -Eq '^AGENT_COMPANY_SOURCE_COMMIT=[a-f0-9]{40}$' "$1" || fail "invalid source commit environment"
  grep -Eq '^AGENT_COMPANY_RELAY_IMAGE=ghcr\.io/ericwong5021/agents-company-relay@sha256:[a-f0-9]{64}$' "$1" || fail "invalid relay image environment"
  grep -Eq '^AGENT_COMPANY_WEBUI_IMAGE=ghcr\.io/ericwong5021/agents-company-webui@sha256:[a-f0-9]{64}$' "$1" || fail "invalid WebUI image environment"
}

compose_arguments() {
  COMPOSE_ARGS=(--env-file "$directory/.env" --env-file "$directory/remote.env" -f "$directory/compose.yaml")
  SERVICES=()
  if [ -f "$directory/compose.proxy.yaml" ]; then
    COMPOSE_ARGS+=(-f "$directory/compose.proxy.yaml")
    SERVICES=(relay webui)
  fi
}

backup_volume() {
  local volume="$1"
  local output="$2"
  docker volume inspect "$volume" >/dev/null 2>&1 || return
  docker run --rm -v "$volume:/source:ro" -v "$output:/backup" alpine:3.22 sh -c "cd /source && tar -czf /backup/${volume##*_}.tar.gz ."
}

restore_volume() {
  local volume="$1"
  local input="$2"
  local archive="$input/${volume##*_}.tar.gz"
  [ -f "$archive" ] || return
  docker run --rm -v "$volume:/target" -v "$input:/backup:ro" alpine:3.22 sh -c "find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -xzf /backup/${volume##*_}.tar.gz -C /target"
}

deploy_vps() {
  [ "$(id -u)" -eq 0 ] || fail "VPS deployment must run with sudo"
  need curl
  need docker
  need gh
  docker compose version >/dev/null 2>&1 || fail "Docker Compose is required"
  [[ "$target" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]] || fail "invalid Preview version"
  [ -f "$directory/.env" ] || fail "$directory/.env is required"
  [ ! -L "$directory" ] || fail "$directory must not be a symbolic link"

  local staging backup previous had_previous=0
  staging="$(mktemp -d "${TMPDIR:-/tmp}/agent-company-release.XXXXXX")"
  chmod 700 "$staging"
  for asset in compose.yaml Caddyfile remote.env source-commit.txt selfhost.sh checksums.txt; do
    release_asset "$asset" "$staging/$asset"
  done
  verify_attestation "$staging/checksums.txt"
  for asset in compose.yaml Caddyfile remote.env source-commit.txt selfhost.sh; do
    verify_checksum "$staging/$asset" "$staging/checksums.txt"
    verify_attestation "$staging/$asset"
  done
  validate_remote_environment "$staging/remote.env"
  [ "$(tr -d '\r\n' < "$staging/source-commit.txt")" = "$(sed -n 's/^AGENT_COMPANY_SOURCE_COMMIT=//p' "$staging/remote.env")" ] || fail "release source commit mismatch"

  install -d -m 700 "$directory/backups"
  backup="$directory/backups/$(date -u +%Y%m%dT%H%M%SZ)-${target#v}"
  install -d -m 700 "$backup"
  if [ -f "$directory/compose.yaml" ] && [ -f "$directory/remote.env" ]; then
    had_previous=1
    cp -p "$directory/compose.yaml" "$directory/remote.env" "$directory/Caddyfile" "$backup/"
    [ -f "$directory/installed-release.txt" ] && cp -p "$directory/installed-release.txt" "$backup/"
    previous="$(sed -n 's/^AGENT_COMPANY_RELEASE=//p' "$directory/remote.env")"
    backup_volume agent-company-remote_relay-data "$backup"
    backup_volume agent-company-remote_webui-data "$backup"
  fi

  install -m 644 "$staging/compose.yaml" "$directory/compose.yaml"
  install -m 644 "$staging/Caddyfile" "$directory/Caddyfile"
  install -m 600 "$staging/remote.env" "$directory/remote.env"
  install -m 755 "$staging/selfhost.sh" "$directory/selfhost.sh"
  compose_arguments
  docker compose "${COMPOSE_ARGS[@]}" config --quiet
  docker compose "${COMPOSE_ARGS[@]}" pull "${SERVICES[@]}"
  if ! docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --wait "${SERVICES[@]}"; then
    if [ "$had_previous" -eq 1 ]; then
      docker compose "${COMPOSE_ARGS[@]}" stop "${SERVICES[@]}" || true
      cp -p "$backup/compose.yaml" "$directory/compose.yaml"
      cp -p "$backup/remote.env" "$directory/remote.env"
      cp -p "$backup/Caddyfile" "$directory/Caddyfile"
      restore_volume agent-company-remote_relay-data "$backup"
      restore_volume agent-company-remote_webui-data "$backup"
      compose_arguments
      docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --wait "${SERVICES[@]}"
      fail "VPS deployment failed and $previous was restored"
    fi
    fail "VPS deployment failed"
  fi
  docker compose "${COMPOSE_ARGS[@]}" exec -T relay bun -e 'fetch("http://127.0.0.1:4318/healthz").then(async response => { const value = await response.json(); if (!response.ok || value.ok !== true) process.exit(1) })'
  docker compose "${COMPOSE_ARGS[@]}" exec -T webui node -e 'fetch("http://127.0.0.1:3000/login").then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'
  printf '%s %s\n' "$target" "$(tr -d '\r\n' < "$staging/source-commit.txt")" > "$directory/installed-release.txt"
  chmod 600 "$directory/installed-release.txt"
  printf 'Agent Company %s deployed from verified GitHub artifacts\n' "$target"
}

case "$action:$provider" in
  install:vps|upgrade:vps) deploy_vps ;;
  *) fail "usage: selfhost.sh install|upgrade vps vX.Y.Z-beta.N" ;;
esac
