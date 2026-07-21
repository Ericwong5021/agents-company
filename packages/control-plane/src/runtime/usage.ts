export type RuntimeUsage = {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function count(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return
  return Math.trunc(value)
}

function first(...values: unknown[]) {
  return values.map(count).find((value): value is number => value !== undefined)
}

function parse(value: Record<string, unknown>): RuntimeUsage | undefined {
  const inputDetails = record(value.input_tokens_details) ?? record(value.prompt_tokens_details)
  const usage = {
    inputTokens: first(value.input_tokens, value.prompt_tokens, value.inputTokens, value.promptTokens),
    outputTokens: first(value.output_tokens, value.completion_tokens, value.outputTokens, value.completionTokens),
    reasoningTokens: first(value.reasoning_tokens, value.reasoningTokens, record(value.output_tokens_details)?.reasoning_tokens),
    cacheReadTokens: first(
      value.cache_read_input_tokens,
      value.cached_input_tokens,
      value.cacheReadTokens,
      inputDetails?.cached_tokens,
    ),
    cacheWriteTokens: first(value.cache_creation_input_tokens, value.cache_write_input_tokens, value.cacheWriteTokens),
  }
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined
}

export function extractRuntimeUsage(value: unknown): RuntimeUsage | undefined {
  const queue = [value]
  const seen = new Set<unknown>()
  while (queue.length) {
    const current = queue.shift()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    const item = record(current)
    if (!item) continue
    const found = parse(item)
    if (found) return found
    ;[item.usage, item.token_usage, item.metrics, item.response, item.item, item.message].forEach((candidate) => {
      if (candidate && typeof candidate === "object") queue.push(candidate)
    })
  }
}
