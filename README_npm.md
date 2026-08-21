# Agent Company Developer CLI

Command-oriented tooling for automation, repository work, and diagnostics.

Agent Company CLI is retained for maintainers, scripts, and one-shot Agent runs. It is not a separate product UI and does not carry feature-parity commitments with the WebUI product.

```bash
npm install -g @agents-company/control-plane
agents --help
```

This npm package exposes the headless local server and command-line operations used by the WebUI. New Agent Company product journeys are designed only for the shared WebUI.

## Existing CLI usage

Install the CLI globally:

```bash
npm install -g @agents-company/control-plane
```

Run a one-shot task from the shell:

```bash
agents run "review the current diff and suggest the riskiest issues"
```

Sign in to providers:

```bash
agents providers login
```

List available models:

```bash
agents models
```

## What It Does

This package supports repository work and automation through explicit commands. The broader Agent Company product is domain-neutral and uses the shared WebUI group workspace as its primary surface.

Use it for:

- Exploring a codebase and turning findings into actionable work.
- Asking agents to implement focused changes in a repository.
- Running reviews before you commit or open a pull request.
- Coordinating multi-step tasks while keeping human approval in the loop.
- Reusing project-specific commands, agents, tools, and server plugins from `.agentcompany`.

The CLI entrypoint is `agents`. The package installs a small JavaScript launcher plus an optional platform-specific binary package for your operating system and CPU.

## Shell Commands

```bash
agents serve
```

Start the local Control Plane HTTP server.

```bash
agents run "summarize this repository"
```

Run a one-shot task and print its result.

```bash
agents providers
agents providers login
```

Inspect or configure model providers.

```bash
agents models
```

List available models.

```bash
agents --help
agents --version
```

Print CLI help or the installed version.

## Package Layout

The public npm packages are intentionally small at this stage:

- `@agents-company/control-plane` contains the Control Plane server and command-line launcher.
- `@agents-company/sdk` is the TypeScript SDK for API clients and integrations.
- `@agents-company/plugin` contains plugin-facing extension types and helpers.
- `@agents-company/shared` contains shared internal utilities used across packages.
- `@agents-company/ui` contains UI building blocks used by Agent Company surfaces.

Future package boundaries may split more runtime code into packages such as `@agents-company/core`, `@agents-company/shared`, and dedicated plugin/runtime packages. The first public CLI release does not move import boundaries just to create those packages.

## Installation Details

The global CLI package depends on optional platform binary packages named like:

- `@agents-company/agentcompany-darwin-arm64`
- `@agents-company/agentcompany-darwin-x64`
- `@agents-company/agentcompany-linux-x64`
- `@agents-company/agentcompany-linux-x64-baseline`
- `@agents-company/agentcompany-linux-x64-musl`
- `@agents-company/agentcompany-windows-x64`

Your package manager should install the one that matches your platform. On Linux, Agent Company distinguishes glibc and musl environments. On x64 machines, it may choose a baseline binary when AVX2 is unavailable.

## Troubleshooting

### `agents` cannot find a platform binary

This usually means optional dependencies were skipped during install.

Try reinstalling without omitting optional dependencies:

```bash
npm uninstall -g @agents-company/control-plane
npm install -g @agents-company/control-plane
```

If you use npm config, check that optional dependencies are enabled:

```bash
npm config get optional
npm config delete optional
```

Avoid installs such as:

```bash
npm install -g @agents-company/control-plane --omit=optional
```

If your environment intentionally omits optional dependencies, manually install the matching binary package next to the CLI package. For example:

```bash
npm install -g @agents-company/agentcompany-linux-x64
```

Use the package name that matches your OS, CPU, libc, and baseline/AVX2 support.

### npm, pnpm, and Bun behave differently

The recommended install path for the public CLI is npm:

```bash
npm install -g @agents-company/control-plane
```

pnpm and Bun can install npm packages, but their global-linking and optional-dependency behavior can differ by version and environment. If `agents --version` fails after a pnpm or Bun global install, verify that optional dependencies were installed and try npm before filing an issue.

### Windows notes

Use a recent Node.js LTS release and install from PowerShell, Windows Terminal, or another normal user shell:

```powershell
npm install -g @agents-company/control-plane
agents --version
```

If execution fails, check that the global npm bin directory is on `PATH`:

```powershell
npm bin -g
```

Corporate endpoint security can also quarantine freshly installed native binaries. If the JavaScript launcher exists but the platform package binary is missing, reinstall the CLI and inspect the package-manager output for optional dependency warnings.

### macOS notes

Both Apple Silicon and Intel macOS are supported through separate optional binary packages. If the wrong architecture is installed under Rosetta or a custom Node setup, reinstall from the shell you intend to use:

```bash
npm uninstall -g @agents-company/control-plane
npm install -g @agents-company/control-plane
agents --version
```

### Linux notes

glibc and musl Linux distributions use different binaries. Alpine Linux usually needs a `musl` package. Debian, Ubuntu, Fedora, and most server distributions usually use the glibc package.

If the CLI starts but the binary cannot execute, check:

```bash
node -p "process.platform + ' ' + process.arch"
ldd --version
```

Then reinstall the CLI without skipping optional dependencies.

### Use a local binary path

For debugging, you can point the launcher to a specific binary:

```bash
AGENTCOMPANY_BIN_PATH=/absolute/path/to/agents agents --version
```

This bypasses optional dependency resolution and is useful for smoke testing a build artifact.

## Requirements

- Node.js LTS with npm for the recommended global install path.
- A supported platform binary package for your OS and CPU.
- Provider credentials for model access. Use `agents providers login` or provider-specific configuration once the CLI is installed.

## License

Agent Company is licensed under the Apache License 2.0. See `LICENSE` in the published package and repository.
