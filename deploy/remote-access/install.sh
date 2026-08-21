#!/usr/bin/env bash
set -euo pipefail

repository="Ericwong5021/agents-company"
release_download="https://github.com/$repository/releases/download"
signer_workflow="$repository/.github/workflows/preview.yml"
target="${1:-}"
install_directory="${AGENT_COMPANY_INSTALL_DIR:-$HOME/.local/bin}"

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

supports_avx2() {
  case "$(uname -s)" in
    Darwin) [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || true)" = 1 ] ;;
    Linux) grep -Eq '(^|[[:space:]])avx2([[:space:]]|$)' /proc/cpuinfo ;;
    *) return 1 ;;
  esac
}

asset_name() {
  local platform architecture suffix=""
  case "$(uname -s)" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *) fail "unsupported operating system" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) architecture=arm64 ;;
    x86_64|amd64) architecture=x64 ;;
    *) fail "unsupported architecture" ;;
  esac
  if [ "$architecture" = x64 ] && ! supports_avx2; then
    suffix=-baseline
  fi
  if [ "$platform" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    suffix="$suffix-musl"
  fi
  if [ "$platform" = darwin ]; then
    printf 'agentcompany-%s-%s%s.zip\n' "$platform" "$architecture" "$suffix"
    return
  fi
  printf 'agentcompany-%s-%s%s.tar.gz\n' "$platform" "$architecture" "$suffix"
}

[[ "$target" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]] || fail "usage: install.sh vX.Y.Z-beta.N"
need curl
need gh
archive="$(asset_name)"
work="$(mktemp -d "${TMPDIR:-/tmp}/agent-company-install.XXXXXX")"
chmod 700 "$work"
release_asset checksums.txt "$work/checksums.txt"
release_asset "$archive" "$work/$archive"
gh attestation verify "$work/checksums.txt" --repo "$repository" --signer-workflow "$signer_workflow" --source-ref "refs/tags/$target" >/dev/null
gh attestation verify "$work/$archive" --repo "$repository" --signer-workflow "$signer_workflow" --source-ref "refs/tags/$target" >/dev/null
expected="$(awk -v asset="$archive" '$2 == asset { print $1 }' "$work/checksums.txt")"
[ -n "$expected" ] || fail "release checksum missing for $archive"
[ "$(digest "$work/$archive")" = "$expected" ] || fail "release checksum mismatch for $archive"
mkdir -p "$work/unpack"
case "$archive" in
  *.zip) unzip -q "$work/$archive" -d "$work/unpack" ;;
  *.tar.gz) tar -xzf "$work/$archive" -C "$work/unpack" ;;
esac
[ -x "$work/unpack/bin/agents" ] || fail "release binary is missing"
mkdir -p "$install_directory"
if [ -f "$install_directory/agents" ]; then
  cp -p "$install_directory/agents" "$install_directory/agents.previous"
fi
install -m 755 "$work/unpack/bin/agents" "$install_directory/agents"
"$install_directory/agents" --version | grep -Fq "${target#v}" || {
  [ -f "$install_directory/agents.previous" ] && mv -f "$install_directory/agents.previous" "$install_directory/agents"
  fail "installed binary version does not match $target"
}
printf 'Agent Company %s installed at %s\n' "$target" "$install_directory/agents"
