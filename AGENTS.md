- 使用中文跟用户对话。
- 只有在缺失信息会实质改变产品结果、权限边界或不可逆操作时才向用户提问；一次只问一个。其余情况基于已有上下文做合理假设并推进，不要重复确认已经收敛的产品决策。
- Use AgentCompany Compose skills when available, otherwise use superpowers skill if installed.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.
- CI triggers on both `main` and `dev` branches.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.
- Agent Company is a new product rebuilt from AgentCompany foundations, not an AgentCompany compatibility release. Do not preserve legacy AgentCompany filesystem/config/API compatibility unless the user explicitly asks for a migration bridge.

## Core Focus (as of 2026-07-30)

The current product target is the local-first **Pre-Public** release described in `docs/product-design/PRODUCT-CONSTITUTION.md` and `docs/Agent Company 产品 PRD.md`.

Current execution order comes from `docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md` (stages R0–R4; the active stage is R0). `docs/product-design/implementation-plan.md` defines milestone architecture and exit criteria but no longer decides what to work on next. Ambient, Reflection, Direct, Dreaming, and Agent Home are frozen until the Life-layer unfreeze conditions in PRD 4.1 are met — do not start work on them, and do not describe them as available.

Founder OS v1 product development is complete at candidate `b7aca6b87ecc7722a3a3fff8b5d027cf66463fa8`; this does not change the R0–R4 release order or authorize higher runtime modes. `founderTwinMode` and `companyCommonsMode` remain fail-closed behind their global maxima, and human authorization or real-sample acceptance must never be inferred from machine Gate success.

- The shared WebUI in `packages/app` is the only product access surface.
- The local Control Plane and agent runtime live in `packages/control-plane`.
- The terminal UI has been removed. Keep the non-interactive CLI and local server headless; do not reintroduce a terminal product surface unless another explicit product decision restores that scope.
- The first public release focuses on a single-user, local-first, domain-neutral Agent company whose core differentiator is dynamic self-organization and self-governance. Do not reduce the product to software development or a preconfigured team of specialist Agents.
- Software development is a deep domain adapter, not the global product boundary. Prefer one primary repository per independently verifiable software delivery unit, while keeping Project and cross-domain work independent from repository count.
- The shared WebUI must prioritize visual quality, group-chat high-signal collaboration, Thread worklog/artifact/preview layers, visible failure attempts, and employee cards driven by real Agent activity projections.
- Ambient roaming, observation, exploration, and socializing remain the long-term design intent — valuable only when backed by real events — but are frozen for now (see above). Future 2D/3D office views must reuse the employee-card state contract instead of inventing decorative activity.
- Keep multi-user cloud hosting, mobile clients, Kanban-first project management, exhaustive industry/app coverage, and a complex 2D/3D office out of the active release scope unless another explicit product decision changes it.
- Product decisions and document precedence are indexed in `docs/README.md`. When code and target design differ, describe the gap rather than presenting planned behavior as implemented.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/control-plane`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/control-plane`), never `tsc` directly.
