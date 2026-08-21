# Security

## Threat model

Agent Company is a local AI development system with access to powerful tools, including shell commands, file operations, Git, network requests, model providers, and MCP servers. Treat an authorized Agent run with the same care as a local developer process acting with your operating-system account.

### No operating-system sandbox guarantee

The permission and approval systems help users understand and authorize actions; they are not an operating-system security sandbox. Unless a runtime explicitly documents stronger isolation, Agent code and tools run with the permissions of the Agent Company process.

For untrusted repositories, tools, plugins, MCP servers, or prompts, use a disposable VM, container, or dedicated OS account and restrict credentials available to the process.

### Local server

The WebUI uses a local Control Plane server. The current single-user Pre-Public path trusts loopback clients; CLI/server modes can be configured separately.

- Keep the server bound to loopback unless remote access is an intentional, reviewed choice.
- Set `AGENTCOMPANY_SERVER_PASSWORD` when running a separately reachable server.
- Do not publish the local port or any configured credentials through logs, screenshots, shell history, or URLs.
- A reverse proxy, tunnel, or LAN bind expands the threat model and is the operator's responsibility.

Trusted loopback access can still be dangerous when other local processes or browser content are untrusted. Keep the Control Plane on loopback, avoid using the product in a hostile local account, and treat any future browser-pairing or non-loopback mode as a separate security boundary that must be explicitly documented and tested before release.

### Private Agent data

The Product Constitution defines strict future boundaries for Agent private spaces and Direct messages. Until a release explicitly marks those boundaries as implemented and its negative tests pass, do not store secrets in experimental Agent identity features on the assumption that planned isolation is already a security control.

Once shipped, any cross-Agent, manager, search, summary, log, backup, or API path that exposes another Agent's private content is a security issue.

### External services

Data sent to configured model providers, MCP servers, plugins, remote repositories, or other integrations is governed by those systems and their credentials. Agent Company cannot provide confidentiality beyond the boundary of a service the user explicitly enables.

## In-scope examples

- Authentication or authorization bypass in a supported server/client configuration;
- Path traversal or arbitrary file access beyond an authorized workspace;
- Cross-Agent private-space or Direct-message disclosure in a released feature;
- Approval-policy bypass that performs an action outside the granted resource scope;
- Credential leakage through logs, diagnostics, URLs, notifications, or exported data;
- Worktree handling that modifies or destroys an unrelated repository/worktree;
- A sandbox claim in a supported runtime that can be escaped.

## Usually out of scope

| Category | Rationale |
|---|---|
| Actions the user explicitly authorized | Tool execution is expected behavior within the granted scope |
| Lack of OS isolation in the default runtime | The default permission UI is not presented as an OS sandbox |
| Provider retention or training policy | Governed by the configured provider |
| Malicious behavior of an explicitly installed MCP server or plugin | External component outside the default trust boundary |
| A user directly editing their own local config or data files | The local user already controls those files |
| Behavior that exists only in target design documents | Planned features are not shipped security boundaries |

An issue may still be in scope when prompt injection or an external component crosses an Agent Company authorization boundary that the user did not grant.

## Reporting a vulnerability

Please use the repository's private GitHub Security Advisory flow:

<https://github.com/Ericwong5021/agents-company/security/advisories/new>

Include:

- affected version and platform;
- required configuration;
- a minimal reproduction;
- actual versus expected authorization boundary;
- impact and whether data or credentials were exposed;
- any suggested mitigation.

Do not include real secrets, private Agent content, or third-party personal data.

We do not accept reports that are generated wholesale by AI or submitted as unverified bulk scanner output. The reporter must personally validate the behavior, provide a minimal reproduction, and be able to explain the concrete authorization boundary and impact. Abusive bulk submissions may result in the reporter being blocked.
