# Existing Nginx topology

Read this reference only when the VPS already uses Nginx or ports 80/443 are occupied by another site.

Keep the released `compose.yaml`, but add an operator-owned `/opt/agent-company-remote/compose.proxy.yaml` with mode `0600`. Select two unused high loopback ports instead of copying occupied values:

```yaml
services:
  relay:
    environment:
      AGENT_COMPANY_RELAY_HOST: 0.0.0.0
    ports: !override
      - 127.0.0.1:<RELAY_PORT>:4318
      - 127.0.0.1:<WEBUI_PORT>:3000
  webui:
    environment:
      HOST: 0.0.0.0
```

The self-host script detects this file, combines it after the release Compose file, and starts only `relay` and `webui`. It preserves the override during upgrades.

Configure one Nginx virtual host for the selected domain. Route only these public Relay paths to the Relay loopback port:

- exact `/healthz`
- exact `/api/v1/remote/connect`
- exact `/api/v1/remote/device-authorizations`
- prefix `/api/v1/remote/device-authorizations/`
- prefix `/api/v1/remote/devices/`

Route every other path to the WebUI loopback port. Never expose `/api/v1/remote/internal/*`.

For Relay routes, use HTTP/1.1, forward the original Host and `X-Forwarded-*` headers, support WebSocket upgrade, disable proxy buffering and caching, and set read/send timeouts long enough for WSS and SSE. Configure at least a 50 MiB request-body limit and an appropriate body timeout.

The active site must redirect HTTP to HTTPS and provide a valid certificate. Apply these response headers:

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
```

Before reloading Nginx, run its configuration test. After reload, verify both the existing unrelated sites and the Agent Company public routes. Do not replace global Nginx configuration or reuse a loopback port without checking listeners.
