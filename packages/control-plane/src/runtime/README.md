# Hermes Runtime for AgentCompany

This module provides a Hermes Runtime Adapter that allows AgentCompany Agent Profiles to be compiled into Hermes Profiles and invoked as local one-shot agents.

## Architecture

AgentCompany remains responsible for:
- Multi-agent orchestration
- Message routing
- Context building
- Scheduling

Hermes is only used as a **single-agent runtime backend**.

## Module Structure

```
runtime/
├── interface.ts          # Shared runtime interfaces
├── roundtable.ts         # Roundtable orchestration
├── example.ts            # Usage examples
├── README.md             # This file
└── hermes/
    ├── types.ts          # Hermes-specific types
    ├── compiler.ts       # HermesProfileCompiler
    ├── adapter.ts        # HermesRuntimeAdapter
    ├── binding-store.ts  # Binding persistence
    ├── service.ts        # Effect service layer
    └── hermes.test.ts    # Tests
```

## Key Interfaces

### RuntimeCompiler

Compiles agent profiles into runtime-specific format.

```typescript
interface RuntimeCompiler {
  readonly runtimeType: string
  compile(agentId: string, agentInfo: unknown): Promise<RuntimeBinding>
  isCompiled(agentId: string): Promise<boolean>
  getBinding(agentId: string): Promise<RuntimeBinding | null>
}
```

### RuntimeAdapter

Runs agents through a specific runtime.

```typescript
interface RuntimeAdapter {
  readonly runtimeType: string
  run(input: AgentRunInput): Promise<AgentRunOutput>
}
```

### AgentRunInput / AgentRunOutput

```typescript
interface AgentRunInput {
  agentId: string
  prompt: string
  context?: Record<string, unknown>
  timeout?: number  // milliseconds
  cwd?: string
}

interface AgentRunOutput {
  agentId: string
  stdout: string
  stderr: string
  exitCode: number
  startedAt: number   // timestamp
  finishedAt: number  // timestamp
  metadata?: Record<string, unknown>
}
```

## Usage

### Basic Usage

```typescript
import { HermesProfileCompiler, HermesRuntimeAdapter, FileBindingStore } from "./hermes"
import type { HermesRuntimeConfig } from "./hermes/types"

// 1. Configure
const config: HermesRuntimeConfig = {
  commandTemplate: "hermes -p <profileName> -z <prompt>",
  defaultTimeout: 300_000, // 5 minutes
  profilePrefix: "agentcompany",
  bindingStorePath: ".agentcompany/runtime/hermes/bindings.json",
  cloneModePreferred: true,
}

// 2. Initialize
const bindingStore = new FileBindingStore(config.bindingStorePath)
const compiler = new HermesProfileCompiler(config, bindingStore, process.cwd())
const adapter = new HermesRuntimeAdapter(config, bindingStore)

// 3. Compile an agent
const agentInfo = {
  id: "ceo",
  name: "CEO",
  description: "Chief Executive Officer",
  system_prompt: "You are the CEO...",
  responsibilities: ["Strategic planning", "Decision making"],
}
const binding = await compiler.compile("ceo", agentInfo)

// 4. Run the agent
const result = await adapter.run({
  agentId: "ceo",
  prompt: "Analyze the current business situation.",
  timeout: 60_000,
})

console.log("Output:", result.stdout)
console.log("Exit code:", result.exitCode)
```

### Roundtable Discussion

The roundtable orchestrator executes a fixed sequence of agents, passing each agent's output to the next.

```typescript
import { runStandardRoundtable } from "./roundtable"

// Standard roundtable: user → ceo → engineer → reviewer → ceo
const result = await runStandardRoundtable(adapter, "Discuss the new feature implementation.")

console.log("Messages:", result.messages)
console.log("Final output:", result.finalOutput)
```

### Custom Roundtable

```typescript
import { RoundtableOrchestrator } from "./roundtable"

const orchestrator = new RoundtableOrchestrator(adapter)
const result = await orchestrator.run({
  goal: "Design the new API",
  participants: ["ceo", "cto", "engineer", "reviewer", "qa", "ceo"],
  context: { project: "payment-service" },
  timeout: 120_000,
})
```

## Compilation Details

### Profile Naming

Hermes profiles are named using the format:
```
agentcompany-<agentId>
```

For example, an agent with ID `ceo` becomes `agentcompany-ceo`.

### Idempotency

Compilation is idempotent using a `compiledHash`. The hash is computed from:
- `system_prompt`
- `instruct`
- `skills`
- `model`
- `responsibilities`

If the hash hasn't changed, the existing binding is returned without recompilation.

### SOUL.md Generation

The compiler writes the agent's persona into the Hermes profile's `SOUL.md`:
1. System prompt
2. Role description
3. Responsibilities
4. Instructions

### Toolset Mapping

AgentCompany tool capabilities are mapped to Hermes toolsets:

| AgentCompany Tool | Hermes Toolset |
|------------------|----------------|
| read             | read           |
| write            | write          |
| edit             | edit           |
| bash             | bash, execute  |
| glob             | search, glob   |
| grep             | search, grep   |
| websearch        | search, web    |
| webfetch         | fetch, web     |

If no tool allowlist is specified, default toolsets are used: read, write, edit, search, execute.

## Effect Service Integration

For use with Effect-TS:

```typescript
import { HermesRuntime, makeHermesRuntimeLayer, defaultHermesConfig } from "./hermes/service"

// Create the layer
const hermesLayer = makeHermesRuntimeLayer(defaultHermesConfig)

// Use in an Effect program
const program = Effect.gen(function* () {
  const { compiler, adapter, bindingStore } = yield* HermesRuntime
  // ... use compiler, adapter, bindingStore
})

// Run with the layer
Effect.runPromise(program.pipe(Effect.provide(hermesLayer)))
```

## Error Handling

The module defines specific error codes:

```typescript
type HermesRuntimeErrorCode =
  | "PROFILE_NOT_FOUND"     // Agent not found in AgentCompany
  | "COMPILATION_FAILED"    // Failed to create Hermes profile
  | "EXECUTION_TIMEOUT"     // Hermes execution timed out
  | "EXECUTION_FAILED"      // Hermes execution failed
  | "BINDING_NOT_FOUND"     // No binding exists for agent
  | "INVALID_CONFIG"        // Invalid configuration
  | "HERMES_NOT_AVAILABLE"  // Hermes CLI not installed
  | "UNKNOWN"               // Unknown error
```

## Non-Goals

- ❌ Do not use Hermes `delegate_task` for AgentCompany orchestration
- ❌ Do not integrate Hermes gateway
- ❌ Do not inject messages into a live Hermes TUI session
- ❌ Do not implement streaming
- ❌ Do not treat Hermes profiles as sandboxes

## Acceptance Criteria

✅ Define ceo, engineer, reviewer AgentCompany profiles
✅ Compile them into Hermes profiles
✅ Run each one through AgentCompany
✅ Start a fixed roundtable and see all messages in AgentCompany
✅ Hermes profile-to-profile communication never happens directly; all communication goes through AgentCompany
