---
name: agent-company-remote-deploy
description: Install, upgrade, diagnose, and accept the Agent Company remote WebUI on a VPS from verified Preview release artifacts while keeping the local Control Plane authoritative. Use for Agent Company VPS deployment, remote access, Relay, HTTPS, reverse-proxy, or remote WebUI requests; do not use for local-only startup or feature development.
---

# Agent Company Remote Deploy

Deploy the public WebUI with the same boundary as Better Codex: the VPS runs the WebUI, Relay, and HTTPS entrypoint; the user's computer keeps the only authoritative Control Plane, Agent runtime, SQLite data, files, credentials, and Git worktrees. The local Control Plane connects outward to the Relay over WSS.

Work from the repository containing this skill. Treat these files as the current source of truth:

- `deploy/remote-access/selfhost.sh`
- `deploy/remote-access/compose.release.yaml`
- `deploy/remote-access/Caddyfile`
- `.github/workflows/preview.yml`
- `packages/control-plane/src/cli/cmd/remote.ts`
- `packages/shared/src/remote-access.ts`

Do not copy commands from an older report when current release assets or source disagree.

## Invariants

- Never deploy a second Control Plane or Agent runtime to the VPS.
- The Relay may persist device, authorization, and audit metadata only. It must not persist company business requests, responses, messages, work, or artifacts.
- Keep the local Control Plane on loopback. Remote access is an outbound WSS tunnel, not a public Control Plane listener.
- Use immutable image digests and verified GitHub Preview release artifacts. A branch head, tag, healthy container, or visible login page alone is not release proof.
- Preserve existing VPS sites, proxies, certificates, secrets, volumes, backups, and unrelated containers.
- Never run `docker compose down -v`, delete deployment volumes, overwrite an existing `.env`, disable SSH host-key checking, or guess SSH credentials.
- Keep Web session credentials, the Relay service token, Better Auth secret, and device token separate.
- Do not put a deployed password or secret in the repository, Git history, report files, command-line arguments, or ordinary logs. Use protected temporary files and mode `0600` for secret transfer.
- Never install GitHub CLI credentials, a GitHub token, or release-bot credentials on the VPS. Public Preview assets must be independently verifiable without GitHub authentication.
- Do not print or repeat the remote login password in the final response. Report whether the retained credential was proven by a real login.

## Select the operation

- Use `install` when the target directory has no valid deployment.
- Use `upgrade` when `/opt/agent-company-remote` already contains `.env`, `compose.yaml`, and `remote.env`. Preserve `.env` and any operator-owned `compose.proxy.yaml`.
- For diagnosis, inspect every boundary before changing state. Do not redeploy merely because one health check fails.

If a missing VPS target, domain, login email, or SSH identity would change the deployment or authorization boundary and cannot be recovered from existing configuration, ask one question. Otherwise rediscover current values and continue.

## Discover current state

1. Check the repository branch, status, HEAD, tags, and remotes. Preserve unrelated work and never reset it.
2. Resolve the requested Preview version. If none was specified, inspect current GitHub releases and select the newest complete Preview whose workflow and assets finished successfully.
3. Require these release assets: `checksums.txt`, `checksums.sig`, `update-public-key.pem`, `selfhost.sh`, `compose.yaml`, `Caddyfile`, `remote.env`, `source-commit.txt`, `install.sh`, and the applicable local CLI archive.
4. Inspect the VPS through its existing trusted SSH route:
   - hostname, OS, architecture, disk space, and time;
   - Docker and Docker Compose availability;
   - listeners on ports 80 and 443;
   - Nginx, Caddy, or another reverse proxy;
   - `/opt/agent-company-remote` contents and permissions;
   - current containers, volumes, installed release, and public DNS.
5. Inspect the local CLI with the exact executable that will be used:
   - `agents --version`
   - `agents remote status`

Versions, SHAs, credentials, hostnames, ports, and connection state are time-sensitive. Verify them live.

## Verify the release before execution

Download bootstrap assets into a protected temporary directory on the trusted workstation. Verify GitHub build provenance for the applicable local CLI archive with the repository and workflow fixed to:

```text
repository: Ericwong5021/agents-company
workflow: Ericwong5021/agents-company/.github/workflows/preview.yml
source ref: refs/tags/<VERSION>
```

Verify the public-key SHA-256 pinned in both `install.sh` and `selfhost.sh`. Then verify the Ed25519 signature in `checksums.sig` over the exact bytes of `checksums.txt`, using Node `crypto.verify` when Node is available and OpenSSL 3 otherwise. Only after the signature succeeds, match every downloaded executable or configuration asset against its SHA-256 entry in the signed manifest. Confirm that `source-commit.txt` equals `AGENT_COMPANY_SOURCE_COMMIT` in `remote.env`, the release tag resolves to that commit, and Relay/WebUI image references use `ghcr.io/ericwong5021/...@sha256:<digest>`.

GitHub attestations are an additional workstation-side provenance check. The portable VPS trust chain is the pinned public-key digest, the Ed25519-signed checksum manifest, and per-asset SHA-256 verification. Do not make VPS deployment depend on `gh attestation verify`, a GitHub login, or a GitHub token.

Do not pipe an unverified remote script into a privileged shell. Copy the verified `selfhost.sh` to the VPS and install it as `/opt/agent-company-remote/selfhost.sh` with mode `0755`.

## Prepare VPS secrets

For a new deployment, create `/opt/agent-company-remote/.env` with owner-only permissions and exactly these operator-controlled values:

```dotenv
AGENT_COMPANY_DOMAIN=<public-hostname>
AGENT_COMPANY_RELAY_SERVICE_TOKEN=<random-value-at-least-32-characters>
AGENT_COMPANY_REMOTE_EMAIL=<owner-email>
AGENT_COMPANY_REMOTE_PASSWORD=<random-value-at-least-12-characters>
BETTER_AUTH_SECRET=<random-value-at-least-32-characters>
```

Generate independent cryptographically random values. Do not reuse SSH, provider, API, or existing application credentials. On upgrade, retain the existing `.env` unless the user explicitly requests credential rotation.

Use `/opt/agent-company-remote` unless the user chose another absolute path. Reject a symbolic-link deployment directory.

## Choose the HTTPS topology

If ports 80 and 443 are free, use the released Compose file and Caddy configuration unchanged.

If the VPS already has a reverse proxy or other sites, keep it. Read [references/existing-nginx.md](references/existing-nginx.md) for the loopback-only Compose override and Nginx routing contract. Allocate unused loopback ports; do not expose Relay or WebUI application ports on a public interface.

## Deploy or upgrade

Run the verified script on the VPS:

```bash
sudo env AGENT_COMPANY_SELFHOST_DIR=/opt/agent-company-remote \
  bash /opt/agent-company-remote/selfhost.sh install vps <VERSION>
```

For an existing deployment:

```bash
sudo env AGENT_COMPANY_SELFHOST_DIR=/opt/agent-company-remote \
  bash /opt/agent-company-remote/selfhost.sh upgrade vps <VERSION>
```

The script must download public release assets over HTTPS, verify the pinned public-key digest, verify the Ed25519 signature before trusting the checksum manifest, verify each consumed asset checksum, preserve secrets, back up Relay and WebUI volumes, pull immutable images, wait for health, record the installed version/source commit, and restore the previous version on failure. Inspect the resulting Compose configuration before starting services.

If the local `agents` CLI is absent or does not match the deployed protocol/release, install the exact release using the verified `install.sh` and platform archive. Preserve the previous executable for rollback.

## Connect the local Control Plane

With the local Control Plane running, start device authorization:

```bash
agents remote connect --url "https://<PUBLIC_HOST>" --name "<DEVICE_NAME>"
```

Open the printed approval URL, sign in with the remote owner account, verify the authorization code and device name, and approve it. Use an available authenticated browser connector when possible; otherwise stop only for the human approval step. The CLI writes the device credential with mode `0600`, and the running Control Plane should connect automatically.

Then inspect:

```bash
agents remote status
```

Do not call the deployment complete until it reports `configured: true` and runtime `connected: true` for the intended Relay URL.

## Acceptance

Verify all applicable layers and keep their evidence separate:

1. Release tag, source commit, workflow completion, workstation attestations, pinned public key, signed manifest, asset checksums, and immutable image digests match.
2. VPS Relay and WebUI containers are healthy; the existing proxy or Caddy is healthy; unrelated services remain intact.
3. Public HTTPS certificate is valid and `GET /healthz` returns the intended release, source commit, protocol version, and `runtime_connected: true`.
4. `/login` returns 200 with the security headers configured by Caddy or the existing proxy.
5. An unauthenticated Agent Company API request is rejected.
6. A real remote login with the configured email and password succeeds; `/api/auth/get-session` returns that email.
7. The authenticated `/api/agent-company/snapshot` request returns 200 and real keys such as `connection`, `company`, `agents`, `work`, and `projects`.
8. Load the actual WebUI and confirm that it renders current local company state. A screenshot or visible login page alone is insufficient.
9. Confirm `agents remote status` still shows `connected: true` after browser traffic.

Do not stop the local Control Plane merely to test offline behavior unless the user authorized that disruption. If full resilience acceptance is requested, verify `runtime_offline` while stopped and recovery after restart without creating a second Runtime or deleting state.

## Failure handling

On failure, collect evidence before repair:

- public response and TLS result;
- reverse-proxy status and logs;
- `docker compose config`, `ps`, health, and bounded Relay/WebUI logs;
- installed release and source commit;
- local Control Plane process/logs and `agents remote status`;
- device authorization/audit state without printing tokens.

Distinguish proxy, WebUI authentication, Relay, WSS, local Control Plane, and business API failures. Let `selfhost.sh` restore the previous deployment when its health gate fails, then confirm that the restored public service and local connection are actually healthy.

## Handoff

Report the public URL, login email, release, source commit, protocol, local connection state, authenticated Snapshot result, and any unperformed human or resilience acceptance. State whether the existing remote credential was retained and proven without printing it. State directly whether installation, authentication, and real local-data access were each proven.

If repository instructions require a report, write equivalent Markdown and standalone HTML files. Keep deployed secrets out of tracked files and ordinary responses.
