# Agent Company CLI

Use Agent Company from your terminal.

Agent Company CLI is the terminal entry point for delegating software work to a structured group of AI agents. You describe the outcome, inspect the plan, approve important steps, and keep work moving inside a terminal UI designed for real projects.

```bash
npm install -g @agents-company/cli
agents
```

This npm package exposes the CLI/TUI surface. The broader Agent Company product is moving toward a shared Web/Desktop workbench with the TUI retained as a secondary client; Web and desktop binaries are not distributed through this package.

## Quick Start

Install the CLI globally:

```bash
npm install -g @agents-company/cli
```

Start the terminal UI in your project:

```bash
cd path/to/your/project
agents
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

Agent Company is built around a terminal UI that treats software work as coordinated company work. Instead of a single chat transcript, the product gives you a place to start goals, inspect agent activity, route tasks, review outputs, and keep project context close to the codebase.

Use it for:

- Exploring a codebase and turning findings into actionable work.
- Asking agents to implement focused changes in a repository.
- Running reviews before you commit or open a pull request.
- Coordinating multi-step tasks while keeping human approval in the loop.
- Reusing project-specific commands, agents, tools, and plugins from `.agentcompany`.

The CLI entrypoint is `agents`. The package installs a small JavaScript launcher plus an optional platform-specific binary package for your operating system and CPU.

## TUI Basics

Start from the project directory you want Agent Company to understand:

```bash
agents
```

Inside the TUI, common patterns include:

- Reference files with `@file` when you want the agent to inspect a specific path.
- Run shell commands with `!command` when you need terminal output in the conversation.
- Use `/connect` to connect or manage provider access.
- Use `/models` to inspect and switch models.
- Use `/help` to see available commands in the current TUI.

The TUI is the core surface of this CLI package, not the primary information architecture of the broader product. Agent Company is not trying to preserve legacy AgentCompany or OpenCode compatibility unless a migration bridge is explicitly documented.

## Shell Commands

```bash
agents
```

Open the terminal UI in the current directory.

```bash
agents run "summarize this repository"
```

Run a task without opening the full TUI.

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

- `@agents-company/cli` is the user-facing terminal CLI and TUI launcher.
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
npm uninstall -g @agents-company/cli
npm install -g @agents-company/cli
```

If you use npm config, check that optional dependencies are enabled:

```bash
npm config get optional
npm config delete optional
```

Avoid installs such as:

```bash
npm install -g @agents-company/cli --omit=optional
```

If your environment intentionally omits optional dependencies, manually install the matching binary package next to the CLI package. For example:

```bash
npm install -g @agents-company/agentcompany-linux-x64
```

Use the package name that matches your OS, CPU, libc, and baseline/AVX2 support.

### npm, pnpm, and Bun behave differently

The recommended install path for the public CLI is npm:

```bash
npm install -g @agents-company/cli
```

pnpm and Bun can install npm packages, but their global-linking and optional-dependency behavior can differ by version and environment. If `agents --version` fails after a pnpm or Bun global install, verify that optional dependencies were installed and try npm before filing an issue.

### Windows notes

Use a recent Node.js LTS release and install from PowerShell, Windows Terminal, or another normal user shell:

```powershell
npm install -g @agents-company/cli
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
npm uninstall -g @agents-company/cli
npm install -g @agents-company/cli
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
