- 使用中文跟用户对话。
- 只有在缺失信息会实质改变产品结果、权限边界或不可逆操作时才向用户提问；一次只问一个。其余情况基于已有上下文做合理假设并推进，不要重复确认已经收敛的产品决策。
- Use AgentCompany Compose skills when available, otherwise use superpowers skill if installed.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.
- CI triggers on both `main` and `dev` branches.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.
- Agent Company is a new product rebuilt from AgentCompany foundations, not an AgentCompany compatibility release. Do not preserve legacy AgentCompany filesystem/config/API compatibility unless the user explicitly asks for a migration bridge.

## Core Focus (as of 2026-07-13)

The current product target is the local-first **Pre-Public** release described in `docs/product-design/PRODUCT-CONSTITUTION.md` and `docs/Agent Company 产品 PRD.md`.

- The shared WebUI in `packages/app` and the Electron shell in `packages/desktop` are the primary product surfaces.
- The local Control Plane and agent runtime live in `packages/control-plane`.
- The TUI in `packages/control-plane/src/cli/cmd/tui/` remains a supported secondary entry point and should share service semantics with the Web/Desktop clients; it must not define the primary product information architecture.
- The first public release focuses on single-user local software development. Do not expand the active scope to multi-user cloud hosting, general-industry delivery, multi-repository projects, Kanban-first project management, or a pixel office without an explicit product decision.
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
