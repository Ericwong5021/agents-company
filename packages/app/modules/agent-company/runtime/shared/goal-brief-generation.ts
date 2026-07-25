import {
  ExperienceApiError,
  GoalBrief,
  GoalBriefStructuredFailure,
  type ExperienceApiError as ExperienceApiErrorValue,
  type GoalBrief as GoalBriefValue,
  type GoalBriefStructuredFailure as GoalBriefStructuredFailureValue,
} from "@agents-company/shared/experience"
import z from "zod"

export type GoalBriefGenerationResponse =
  | { kind: "success"; brief: GoalBriefValue }
  | { kind: "structured_failure"; failure: GoalBriefStructuredFailureValue }
  | {
      kind: "conflict"
      error: Extract<ExperienceApiErrorValue, { code: "request_conflict" | "request_in_progress" }>
    }

const GoalDraftStorage = z
  .object({
    version: z.literal(1),
    draft: z.string().max(8_000),
    request: z
      .object({
        goal: z.string().trim().min(1).max(8_000),
        requestId: z.string().trim().min(1).max(240),
      })
      .strict()
      .nullable(),
  })
  .strict()

export type GoalDraftStorage = z.infer<typeof GoalDraftStorage>
export type GoalDraftRequest = NonNullable<GoalDraftStorage["request"]>

export function parseGoalDraftStorage(value: string | null): GoalDraftStorage {
  if (!value) return { version: 1, draft: "", request: null }
  try {
    const parsed = GoalDraftStorage.safeParse(JSON.parse(value) as unknown)
    if (parsed.success)
      return parsed.data.request?.goal === parsed.data.draft.trim()
        ? parsed.data
        : { ...parsed.data, request: null }
  } catch {}
  return { version: 1, draft: "", request: null }
}

export function serializeGoalDraftStorage(value: GoalDraftStorage) {
  return JSON.stringify(GoalDraftStorage.parse(value))
}

export function goalDraftRequest(
  goal: string,
  current: GoalDraftStorage["request"],
  createRequestID: () => string,
): GoalDraftRequest {
  const normalized = goal.trim()
  if (current?.goal === normalized) return current
  return { goal: normalized, requestId: createRequestID() }
}

export function isCurrentGoalDraftRequest(
  draft: string,
  current: GoalDraftStorage["request"],
  request: GoalDraftRequest,
) {
  return (
    draft.trim() === request.goal &&
    current?.goal === request.goal &&
    current.requestId === request.requestId
  )
}

export function parseGoalBriefGenerationResponse(
  status: number,
  value: unknown,
): GoalBriefGenerationResponse | undefined {
  if (status === 200) {
    const result = GoalBrief.safeParse(value)
    if (result.success && !result.data.projectId && !result.data.sourceThreadId) {
      return { kind: "success", brief: result.data }
    }
    return
  }
  if (status === 422) {
    const result = GoalBriefStructuredFailure.safeParse(value)
    return result.success ? { kind: "structured_failure", failure: result.data } : undefined
  }
  if (status !== 409) return
  const result = ExperienceApiError.safeParse(value)
  if (
    !result.success ||
    (result.data.code !== "request_conflict" && result.data.code !== "request_in_progress")
  ) return
  return { kind: "conflict", error: result.data }
}
