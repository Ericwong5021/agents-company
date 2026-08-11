import type { WorkItem } from "./schema"

export const workItemContractViolations = [
  "planner_review_forbidden",
  "planner_verification_forbidden",
  "worker_verification_forbidden",
  "worker_reviewer_capability_forbidden",
  "non_reviewer_target_forbidden",
  "review_status_mismatch",
  "reviewer_contract_mismatch",
  "reviewer_target_missing",
  "reviewer_target_not_worker",
  "reviewer_target_inactive",
  "reviewer_target_scope_mismatch",
  "reviewer_target_contract_version_mismatch",
  "reviewer_dependency_missing",
  "reviewer_not_independent",
  "duplicate_reviewer_target",
] as const

export type WorkItemContractViolation = (typeof workItemContractViolations)[number]

export type WorkItemContractCandidate = Pick<WorkItem, "kind" | "purpose" | "review_status" | "validation_mode"> &
  Partial<
    Pick<
      WorkItem,
      | "id"
      | "project_id"
      | "plan_id"
      | "parent_id"
      | "reviews_work_item_id"
      | "owner_agent_id"
      | "capability_packs"
      | "status"
      | "validation_contract_version"
    >
  >

export type WorkItemContractNode = Pick<WorkItem, "id" | "kind"> &
  Partial<
    Pick<
      WorkItem,
      | "project_id"
      | "plan_id"
      | "parent_id"
      | "reviews_work_item_id"
      | "owner_agent_id"
      | "status"
      | "validation_contract_version"
    >
  >

export function validateWorkItemContract(input: {
  item: WorkItemContractCandidate
  review_target?: WorkItemContractNode | null
  reviewers?: readonly WorkItemContractNode[]
  dependency_ids?: readonly string[]
}) {
  const violations = new Set<WorkItemContractViolation>()
  const requiresReview = ["independent_review", "review_and_user_gate"].includes(input.item.validation_mode)
  if (input.item.kind !== "reviewer" && input.item.reviews_work_item_id)
    violations.add("non_reviewer_target_forbidden")

  if (input.item.kind === "planner") {
    if (input.item.review_status !== "not_required" || requiresReview) violations.add("planner_review_forbidden")
    if (input.item.purpose === "verification") violations.add("planner_verification_forbidden")
  }

  if (input.item.kind === "worker") {
    if (input.item.purpose === "verification") violations.add("worker_verification_forbidden")
    if (input.item.capability_packs?.includes("independent-review@1"))
      violations.add("worker_reviewer_capability_forbidden")
    if (requiresReview === (input.item.review_status === "not_required")) violations.add("review_status_mismatch")
  }

  if (input.item.kind !== "reviewer") return [...violations]

  if (
    input.item.purpose !== "verification" ||
    input.item.review_status !== "not_required" ||
    input.item.validation_mode !== "independent_review"
  )
    violations.add("reviewer_contract_mismatch")
  if (!input.item.reviews_work_item_id) violations.add("reviewer_target_missing")
  if (input.dependency_ids && !input.item.reviews_work_item_id) violations.add("reviewer_dependency_missing")
  if (
    input.dependency_ids &&
    input.item.reviews_work_item_id &&
    !input.dependency_ids.includes(input.item.reviews_work_item_id)
  )
    violations.add("reviewer_dependency_missing")

  if (input.review_target === undefined) return [...violations]
  if (!input.review_target) {
    violations.add("reviewer_target_missing")
    return [...violations]
  }
  if (input.review_target.kind !== "worker") violations.add("reviewer_target_not_worker")
  if (["superseded", "cancelled"].includes(input.review_target.status ?? "pending"))
    violations.add("reviewer_target_inactive")
  if (
    (input.item.project_id &&
      input.review_target.project_id &&
      input.item.project_id !== input.review_target.project_id) ||
    (input.item.plan_id && input.review_target.plan_id && input.item.plan_id !== input.review_target.plan_id)
  )
    violations.add("reviewer_target_scope_mismatch")
  if (input.item.validation_contract_version === 2 && input.review_target.validation_contract_version !== 2)
    violations.add("reviewer_target_contract_version_mismatch")
  if (
    input.item.owner_agent_id &&
    input.review_target.owner_agent_id &&
    input.item.owner_agent_id === input.review_target.owner_agent_id
  )
    violations.add("reviewer_not_independent")
  if (
    input.reviewers?.some(
      (reviewer) =>
        reviewer.id !== input.item.id &&
        reviewer.kind === "reviewer" &&
        reviewer.reviews_work_item_id === input.item.reviews_work_item_id &&
        !["superseded", "cancelled"].includes(reviewer.status ?? "pending"),
    )
  )
    violations.add("duplicate_reviewer_target")
  return [...violations]
}

export function assertWorkItemContract(input: Parameters<typeof validateWorkItemContract>[0]) {
  const violations = validateWorkItemContract(input)
  if (violations.length) throw new Error(`Invalid WorkItem contract: ${violations.sort().join(", ")}`)
}
