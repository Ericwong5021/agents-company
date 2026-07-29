import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

function number(key: string) {
  const value = process.env[key]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function seedGrowExecutionMode() {
  const value = process.env["AGENTCOMPANY_SEED_GROW_ORCHESTRATION"]
  if (value === undefined || value === "off" || value === "shadow" || value === "active") return value
  throw new Error("AGENTCOMPANY_SEED_GROW_ORCHESTRATION must be off, shadow, or active.")
}

function option<const T extends string>(key: string, values: readonly T[], fallback: T) {
  const value = process.env[key] ?? fallback
  if (values.includes(value as T)) return value as T
  throw new Error(`${key} must be one of: ${values.join(", ")}.`)
}

const AGENTCOMPANY_EXPERIMENTAL = truthy("AGENTCOMPANY_EXPERIMENTAL")

// Defaults to false. When enabled, agentcompany runs in agents-only mode:
//   — does NOT inherit Claude Code's settings (CLAUDE.md, ~/.claude/skills, etc.)
//   — does NOT pick up provider API keys from environment variables
//   — falls back to the agents-auto model as the default
// Set AGENTCOMPANY_MIMO_ONLY=true to disable .claude inheritance and env-based
// provider auto-detection.
const AGENTCOMPANY_MIMO_ONLY = truthy("AGENTCOMPANY_MIMO_ONLY")
const AGENTCOMPANY_DISABLE_CLAUDE_CODE_ENV = truthy("AGENTCOMPANY_DISABLE_CLAUDE_CODE")
const AGENTCOMPANY_DISABLE_CLAUDE_CODE = AGENTCOMPANY_MIMO_ONLY || AGENTCOMPANY_DISABLE_CLAUDE_CODE_ENV

const AGENTCOMPANY_DISABLE_EXTERNAL_SKILLS = truthy("AGENTCOMPANY_DISABLE_EXTERNAL_SKILLS")
const AGENTCOMPANY_DISABLE_CLAUDE_CODE_SKILLS =
  AGENTCOMPANY_DISABLE_EXTERNAL_SKILLS ||
  AGENTCOMPANY_DISABLE_CLAUDE_CODE ||
  truthy("AGENTCOMPANY_DISABLE_CLAUDE_CODE_SKILLS")
const copy = process.env["AGENTCOMPANY_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  AGENTCOMPANY_AUTO_SHARE: truthy("AGENTCOMPANY_AUTO_SHARE"),
  AGENTCOMPANY_AUTO_HEAP_SNAPSHOT: truthy("AGENTCOMPANY_AUTO_HEAP_SNAPSHOT"),
  AGENTCOMPANY_GIT_BASH_PATH: process.env["AGENTCOMPANY_GIT_BASH_PATH"],
  AGENTCOMPANY_CONFIG: process.env["AGENTCOMPANY_CONFIG"],
  AGENTCOMPANY_CONFIG_CONTENT: process.env["AGENTCOMPANY_CONFIG_CONTENT"],

  AGENTCOMPANY_DISABLE_AUTOUPDATE: truthy("AGENTCOMPANY_DISABLE_AUTOUPDATE"),

  // Defaults to false (rotation enabled). When enabled, the active log file is
  // never archived to <name>.log.<stamp> on hitting MAX_FILE_SIZE — it grows in
  // place. Useful when an external tool tails/manages the single log file.
  AGENTCOMPANY_DISABLE_LOG_ROTATION: truthy("AGENTCOMPANY_DISABLE_LOG_ROTATION"),

  // Defaults to true (analytics enabled). Set AGENTCOMPANY_ENABLE_ANALYSIS=false
  // to opt out of POSTing model_call/tool_call/agent_request metrics.
  AGENTCOMPANY_ENABLE_ANALYSIS: !falsy("AGENTCOMPANY_ENABLE_ANALYSIS"),
  AGENTCOMPANY_ALWAYS_NOTIFY_UPDATE: truthy("AGENTCOMPANY_ALWAYS_NOTIFY_UPDATE"),
  AGENTCOMPANY_DISABLE_PRUNE: truthy("AGENTCOMPANY_DISABLE_PRUNE"),
  AGENTCOMPANY_DISABLE_TERMINAL_TITLE: truthy("AGENTCOMPANY_DISABLE_TERMINAL_TITLE"),
  AGENTCOMPANY_SHOW_TTFD: truthy("AGENTCOMPANY_SHOW_TTFD"),
  AGENTCOMPANY_PERMISSION: process.env["AGENTCOMPANY_PERMISSION"],
  AGENTCOMPANY_DISABLE_DEFAULT_PLUGINS: truthy("AGENTCOMPANY_DISABLE_DEFAULT_PLUGINS"),
  AGENTCOMPANY_DISABLE_LSP_DOWNLOAD: truthy("AGENTCOMPANY_DISABLE_LSP_DOWNLOAD"),
  AGENTCOMPANY_ENABLE_EXPERIMENTAL_MODELS: truthy("AGENTCOMPANY_ENABLE_EXPERIMENTAL_MODELS"),
  AGENTCOMPANY_DISABLE_AUTOCOMPACT: truthy("AGENTCOMPANY_DISABLE_AUTOCOMPACT"),
  AGENTCOMPANY_DISABLE_MODELS_FETCH: truthy("AGENTCOMPANY_DISABLE_MODELS_FETCH"),
  AGENTCOMPANY_DISABLE_MOUSE: truthy("AGENTCOMPANY_DISABLE_MOUSE"),
  AGENTCOMPANY_OUTPUT_LENGTH_CONTINUATION_LIMIT: number("AGENTCOMPANY_OUTPUT_LENGTH_CONTINUATION_LIMIT") ?? 3,
  AGENTCOMPANY_INVALID_OUTPUT_CONTINUATION_LIMIT: number("AGENTCOMPANY_INVALID_OUTPUT_CONTINUATION_LIMIT") ?? 2,

  // Sliding-window n-gram repetition detection for streamed reasoning + text.
  // An n-gram of size N appearing REPEAT_THRESHOLD times within the last
  // WINDOW_TOKENS tokens triggers recovery (remind → replan → terminate).
  AGENTCOMPANY_TEXT_NGRAM_N: number("AGENTCOMPANY_TEXT_NGRAM_N") ?? 6,
  AGENTCOMPANY_TEXT_REPEAT_THRESHOLD: number("AGENTCOMPANY_TEXT_REPEAT_THRESHOLD") ?? 3,
  AGENTCOMPANY_TEXT_WINDOW_TOKENS: number("AGENTCOMPANY_TEXT_WINDOW_TOKENS") ?? 500,

  // Caps applied to image attachments before a prompt is sent. Both default to
  // undefined (no limit). AGENTCOMPANY_MAX_PROMPT_IMAGES bounds how many images may
  // be sent per request (oldest excess images are dropped); AGENTCOMPANY_MAX_PROMPT_IMAGE_SIZE
  // bounds the decoded byte size of a single image. Values must be positive integers.
  AGENTCOMPANY_MAX_PROMPT_IMAGES: number("AGENTCOMPANY_MAX_PROMPT_IMAGES"),
  AGENTCOMPANY_MAX_PROMPT_IMAGE_SIZE: number("AGENTCOMPANY_MAX_PROMPT_IMAGE_SIZE"),
  AGENTCOMPANY_MIMO_ONLY,
  AGENTCOMPANY_DISABLE_PROVIDER_ENV: AGENTCOMPANY_MIMO_ONLY || truthy("AGENTCOMPANY_DISABLE_PROVIDER_ENV"),
  AGENTCOMPANY_DISABLE_CLAUDE_CODE,
  get AGENTCOMPANY_DISABLE_CLAUDE_CODE_MCP() {
    // MCP compatibility stays on in agents-only mode so users can reuse Claude Code
    // MCP servers without inheriting prompts, skills, or provider env keys.
    return AGENTCOMPANY_DISABLE_CLAUDE_CODE_ENV || truthy("AGENTCOMPANY_DISABLE_CLAUDE_CODE_MCP")
  },
  AGENTCOMPANY_DISABLE_CLAUDE_CODE_PROMPT:
    AGENTCOMPANY_DISABLE_CLAUDE_CODE || truthy("AGENTCOMPANY_DISABLE_CLAUDE_CODE_PROMPT"),
  // Defaults to false (enabled): markdown commands under ~/.claude/commands and
  // {project}/.claude/commands load as slash commands. Independent of the
  // agents-only master switch. Set AGENTCOMPANY_DISABLE_CLAUDE_CODE_COMMANDS=true to disable.
  AGENTCOMPANY_DISABLE_CLAUDE_CODE_COMMANDS: truthy("AGENTCOMPANY_DISABLE_CLAUDE_CODE_COMMANDS"),
  AGENTCOMPANY_DISABLE_CLAUDE_CODE_SKILLS,
  AGENTCOMPANY_DISABLE_EXTERNAL_SKILLS,
  AGENTCOMPANY_DISABLE_CODEX_SKILLS:
    AGENTCOMPANY_DISABLE_EXTERNAL_SKILLS || truthy("AGENTCOMPANY_DISABLE_CODEX_SKILLS"),
  AGENTCOMPANY_DISABLE_CONTROL_PLANE_SKILLS:
    AGENTCOMPANY_DISABLE_EXTERNAL_SKILLS || truthy("AGENTCOMPANY_DISABLE_CONTROL_PLANE_SKILLS"),
  AGENTCOMPANY_FAKE_VCS: process.env["AGENTCOMPANY_FAKE_VCS"],

  // When enabled, skips all git subprocess calls during project discovery
  // (which git, rev-parse --git-common-dir, rev-parse --show-toplevel) and
  // branch detection. The project is treated as a non-git directory rooted at
  // the working directory. Use to avoid touching git in restricted/sandboxed
  // environments or where git startup probing is undesirable.
  AGENTCOMPANY_DISABLE_GIT: truthy("AGENTCOMPANY_DISABLE_GIT"),
  AGENTCOMPANY_SERVER_PASSWORD: process.env["AGENTCOMPANY_SERVER_PASSWORD"],
  AGENTCOMPANY_SERVER_USERNAME: process.env["AGENTCOMPANY_SERVER_USERNAME"],
  AGENTCOMPANY_ENABLE_QUESTION_TOOL: truthy("AGENTCOMPANY_ENABLE_QUESTION_TOOL"),

  // Experimental
  AGENTCOMPANY_EXPERIMENTAL,
  AGENTCOMPANY_EXPERIMENTAL_FILEWATCHER: Config.boolean("AGENTCOMPANY_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  AGENTCOMPANY_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("AGENTCOMPANY_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  AGENTCOMPANY_EXPERIMENTAL_ICON_DISCOVERY:
    AGENTCOMPANY_EXPERIMENTAL || truthy("AGENTCOMPANY_EXPERIMENTAL_ICON_DISCOVERY"),
  AGENTCOMPANY_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("AGENTCOMPANY_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  AGENTCOMPANY_ENABLE_EXA:
    truthy("AGENTCOMPANY_ENABLE_EXA") || AGENTCOMPANY_EXPERIMENTAL || truthy("AGENTCOMPANY_EXPERIMENTAL_EXA"),
  AGENTCOMPANY_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: number("AGENTCOMPANY_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  AGENTCOMPANY_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number("AGENTCOMPANY_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  AGENTCOMPANY_EXPERIMENTAL_OXFMT: AGENTCOMPANY_EXPERIMENTAL || truthy("AGENTCOMPANY_EXPERIMENTAL_OXFMT"),
  AGENTCOMPANY_EXPERIMENTAL_LSP_TY: truthy("AGENTCOMPANY_EXPERIMENTAL_LSP_TY"),
  AGENTCOMPANY_EXPERIMENTAL_LSP_TOOL: AGENTCOMPANY_EXPERIMENTAL || truthy("AGENTCOMPANY_EXPERIMENTAL_LSP_TOOL"),
  // Defaults to true: dynamic workflow + built-in deep-research are on by default.
  // Set AGENTCOMPANY_EXPERIMENTAL_WORKFLOW_TOOL=false to opt out. The env-var name is
  // kept for backwards compat (long-running experiments still pass it as `1`).
  AGENTCOMPANY_EXPERIMENTAL_WORKFLOW_TOOL: !falsy("AGENTCOMPANY_EXPERIMENTAL_WORKFLOW_TOOL"),
  AGENTCOMPANY_EXPERIMENTAL_MARKDOWN: !falsy("AGENTCOMPANY_EXPERIMENTAL_MARKDOWN"),
  AGENTCOMPANY_MODELS_URL: process.env["AGENTCOMPANY_MODELS_URL"],
  AGENTCOMPANY_MODELS_PATH: process.env["AGENTCOMPANY_MODELS_PATH"],
  get AGENTCOMPANY_SEED_GROW_ORCHESTRATION_OVERRIDE() {
    return seedGrowExecutionMode()
  },
  get AGENTCOMPANY_SEED_GROW_ORCHESTRATION() {
    return seedGrowExecutionMode() ?? "off"
  },
  get AGENTCOMPANY_FOUNDER_TWIN_MODE() {
    return option(
      "AGENTCOMPANY_FOUNDER_TWIN_MODE",
      ["off", "shadow", "advisor", "green-delegated", "yellow-delegated"] as const,
      "off",
    )
  },
  get AGENTCOMPANY_COMPANY_COMMONS_MODE() {
    return option(
      "AGENTCOMPANY_COMPANY_COMMONS_MODE",
      ["off", "ingest-only", "reading", "belief-loop"] as const,
      "off",
    )
  },
  AGENTCOMPANY_DISABLE_EMBEDDED_WEB_UI: truthy("AGENTCOMPANY_DISABLE_EMBEDDED_WEB_UI"),
  AGENTCOMPANY_DB: process.env["AGENTCOMPANY_DB"],

  // Defaults to true — all channels share a single agent-company.db. The per-channel
  // DB isolation (agent-company-{channel}.db) is unnecessary since we
  // don't ship multiple release channels yet. Use AGENTCOMPANY_HOME to isolate dev
  // environments instead. Set AGENTCOMPANY_DISABLE_CHANNEL_DB=false to restore
  // per-channel isolation.
  AGENTCOMPANY_DISABLE_CHANNEL_DB: !falsy("AGENTCOMPANY_DISABLE_CHANNEL_DB"),
  AGENTCOMPANY_SKIP_MIGRATIONS: truthy("AGENTCOMPANY_SKIP_MIGRATIONS"),
  AGENTCOMPANY_STRICT_CONFIG_DEPS: truthy("AGENTCOMPANY_STRICT_CONFIG_DEPS"),

  AGENTCOMPANY_WORKSPACE_ID: process.env["AGENTCOMPANY_WORKSPACE_ID"],
  AGENTCOMPANY_EXPERIMENTAL_HTTPAPI: truthy("AGENTCOMPANY_EXPERIMENTAL_HTTPAPI"),
  AGENTCOMPANY_EXPERIMENTAL_WORKSPACES: AGENTCOMPANY_EXPERIMENTAL || truthy("AGENTCOMPANY_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.

  // Disables compose-agent-internal skills (e.g. compose:plan, compose:review,
  // compose:tdd). These are hidden workflow-orchestration skills only visible
  // to the compose agent and are NOT part of builtin skills.
  get AGENTCOMPANY_DISABLE_COMPOSE_SKILLS() {
    return truthy("AGENTCOMPANY_DISABLE_COMPOSE_SKILLS")
  },
  // Disables user-facing builtin skills shipped with the binary (e.g.
  // self-extend). Does not affect compose skills — the two sets are
  // independent and non-overlapping.
  get AGENTCOMPANY_DISABLE_BUILTIN_SKILLS() {
    return truthy("AGENTCOMPANY_DISABLE_BUILTIN_SKILLS")
  },
  get AGENTCOMPANY_DISABLE_PROJECT_CONFIG() {
    return truthy("AGENTCOMPANY_DISABLE_PROJECT_CONFIG")
  },
  get AGENTCOMPANY_CONFIG_DIR() {
    return process.env["AGENTCOMPANY_CONFIG_DIR"]
  },
  get AGENTCOMPANY_PURE() {
    return truthy("AGENTCOMPANY_PURE")
  },
  get AGENTCOMPANY_PLUGIN_META_FILE() {
    return process.env["AGENTCOMPANY_PLUGIN_META_FILE"]
  },
  get AGENTCOMPANY_CLIENT() {
    return process.env["AGENTCOMPANY_CLIENT"] ?? "cli"
  },
  // Emergency release switch: disabling new board messages preserves the
  // persisted read model and source history while hiding every send entry.
  get AGENTCOMPANY_DISABLE_BOARD_MESSAGES() {
    return truthy("AGENTCOMPANY_DISABLE_BOARD_MESSAGES")
  },
}
