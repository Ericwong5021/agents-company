import {
  GraphPolicyVerdict,
  GraphSnapshot,
  type GraphMutationProposal,
  type GraphPolicyViolation,
  type GraphSnapshot as GraphSnapshotType,
  type WorkReceiptEvidenceRef,
} from "./schema"

const referenceKey = (reference: WorkReceiptEvidenceRef) => `${reference.kind}:${reference.id}`
const dependencyKey = (work_item_id: string, depends_on_id: string) => `${work_item_id}\u0000${depends_on_id}`

function hasCycle(snapshot: GraphSnapshotType) {
  const active = new Set(
    snapshot.nodes
      .filter((node) => !["superseded", "cancelled"].includes(node.status))
      .map((node) => node.id),
  )
  const outgoing = new Map<string, string[]>()
  const incoming = new Map([...active].map((id) => [id, 0]))
  snapshot.dependencies
    .filter((edge) => active.has(edge.work_item_id) && active.has(edge.depends_on_id))
    .forEach((edge) => {
      outgoing.set(edge.work_item_id, [...(outgoing.get(edge.work_item_id) ?? []), edge.depends_on_id])
      incoming.set(edge.depends_on_id, (incoming.get(edge.depends_on_id) ?? 0) + 1)
    })
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id)
  const visited: string[] = []
  for (const id of ready) {
    visited.push(id)
    ;(outgoing.get(id) ?? []).forEach((next) => {
      const remaining = (incoming.get(next) ?? 0) - 1
      incoming.set(next, remaining)
      if (remaining === 0) ready.push(next)
    })
  }
  return visited.length !== active.size
}

function hasParentCycle(snapshot: GraphSnapshotType) {
  const nodes = new Map(
    snapshot.nodes
      .filter((node) => !["superseded", "cancelled"].includes(node.status))
      .map((node) => [node.id, node]),
  )
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const parent_id = nodes.get(id)?.parent_id
    const cycle = parent_id && nodes.has(parent_id) ? visit(parent_id) : false
    visiting.delete(id)
    visited.add(id)
    return cycle
  }
  return [...nodes.keys()].some(visit)
}

function decisionMatches(input: GraphMutationProposal) {
  const types = new Set(input.operations.map((operation) => operation.type))
  if (["accept", "retry", "quiesce"].includes(input.decision)) return types.size === 0
  if (input.decision === "expand") return types.has("add_work_item")
  if (input.decision === "rewire")
    return (
      types.size > 0 &&
      [...types].every((type) => type === "add_dependency" || type === "remove_dependency")
    )
  if (input.decision === "supersede") return types.has("supersede_work_item")
  if (input.decision === "request_capability") return types.has("request_capability")
  return types.has("request_user_decision") || types.has("add_validation_gate")
}

export function validateGraphPatch(input: {
  proposal: GraphMutationProposal
  snapshot: GraphSnapshotType
  valid_plan_ids: string[]
  trigger_work_item_id: string
  receipt_evidence_refs: WorkReceiptEvidenceRef[]
}) {
  const violations = new Set<GraphPolicyViolation>()
  const nodes = new Map(input.snapshot.nodes.map((node) => [node.id, { ...node }]))
  const dependencies = new Set(
    input.snapshot.dependencies.map((edge) => dependencyKey(edge.work_item_id, edge.depends_on_id)),
  )
  const trigger = nodes.get(input.trigger_work_item_id)
  const evidence = new Set(input.receipt_evidence_refs.map(referenceKey))
  const validationGates = input.proposal.operations
    .filter((operation) => operation.type === "add_validation_gate")
    .map((operation) => operation.gate)
  const graphChanges = input.proposal.operations.some((operation) =>
    ["add_work_item", "add_dependency", "remove_dependency", "supersede_work_item"].includes(operation.type),
  )
  const addedNodeCount = input.proposal.operations.filter((operation) => operation.type === "add_work_item").length

  if (!decisionMatches(input.proposal)) violations.add("decision_operation_mismatch")
  if (addedNodeCount > 3) violations.add("growth_budget_exceeded")
  if (
    graphChanges &&
    (!input.proposal.evidence_refs.length ||
      new Set(input.proposal.evidence_refs.map(referenceKey)).size !== input.proposal.evidence_refs.length ||
      input.proposal.evidence_refs.some((reference) => !evidence.has(referenceKey(reference))))
  ) {
    violations.add("evidence_required")
  }
  if (!trigger) violations.add("missing_node")

  input.proposal.operations
    .filter((operation) => operation.type === "add_work_item")
    .forEach((operation) => {
      if (nodes.has(operation.item.id)) {
        violations.add("duplicate_new_node")
        return
      }
      if (!input.valid_plan_ids.includes(operation.item.plan_id)) violations.add("invalid_plan")
      if (
        !trigger ||
        operation.item.decision_scope.some((scope) => !trigger.decision_scope.includes(scope)) ||
        operation.item.resource_scope.some((scope) => !trigger.resource_scope.includes(scope))
      ) {
        violations.add("scope_escalation")
      }
      if (
        operation.item.risk_level === "high" &&
        (operation.item.validation_mode !== "review_and_user_gate" ||
          !validationGates.some(
            (gate) =>
              gate.work_item_id === operation.item.id &&
              gate.risk_level === "high" &&
              gate.validation_mode === "review_and_user_gate",
          ))
      ) {
        violations.add("high_risk_gate_required")
      }
      nodes.set(operation.item.id, {
        id: operation.item.id,
        plan_id: operation.item.plan_id,
        parent_id: operation.item.parent_id,
        kind: operation.item.kind,
        status: "pending",
        owner_agent_id: operation.item.owner_agent_id,
        decision_scope: operation.item.decision_scope,
        resource_scope: operation.item.resource_scope,
        acceptance_criteria: operation.item.acceptance_criteria,
        risk_level: operation.item.risk_level,
        purpose: operation.item.purpose,
        validation_mode: operation.item.validation_mode,
        superseded_by_id: undefined,
      })
    })

  input.proposal.operations.forEach((operation) => {
    if (operation.type === "add_work_item") {
      if (operation.item.parent_id && !nodes.has(operation.item.parent_id)) violations.add("missing_node")
      const parent = operation.item.parent_id ? nodes.get(operation.item.parent_id) : undefined
      if (
        operation.item.kind === "reviewer" &&
        (operation.item.validation_mode === "self_check" ||
          !parent ||
          (operation.item.owner_agent_id &&
            parent.owner_agent_id &&
            operation.item.owner_agent_id === parent.owner_agent_id))
      ) {
        violations.add("self_review")
      }
      return
    }
    if (operation.type === "add_dependency" || operation.type === "remove_dependency") {
      if (operation.work_item_id === operation.depends_on_id) violations.add("self_dependency")
      const item = nodes.get(operation.work_item_id)
      if (!item || !nodes.has(operation.depends_on_id)) {
        violations.add("missing_node")
        return
      }
      if (["completed", "superseded"].includes(item.status)) violations.add("immutable_fact")
      if (item.status === "running") violations.add("running_dependency_change")
      const key = dependencyKey(operation.work_item_id, operation.depends_on_id)
      if (operation.type === "add_dependency") {
        if (dependencies.has(key)) violations.add("dependency_exists")
        dependencies.add(key)
        return
      }
      if (!dependencies.has(key)) violations.add("dependency_missing")
      dependencies.delete(key)
      return
    }
    if (operation.type === "supersede_work_item") {
      const item = nodes.get(operation.work_item_id)
      if (!item) {
        violations.add("missing_node")
        return
      }
      if (["running", "completed", "superseded"].includes(item.status)) violations.add("immutable_fact")
      const replacement = operation.replacement_id ? nodes.get(operation.replacement_id) : undefined
      if (
        operation.replacement_id &&
        (operation.replacement_id === operation.work_item_id ||
          !replacement ||
          ["superseded", "cancelled"].includes(replacement.status))
      ) {
        violations.add("invalid_replacement")
      }
      nodes.set(operation.work_item_id, {
        ...item,
        status: "superseded",
        superseded_by_id: operation.replacement_id,
      })
      return
    }
    if (operation.type === "add_validation_gate") {
      const item = nodes.get(operation.gate.work_item_id)
      if (!item) violations.add("missing_node")
      if (item && ["completed", "superseded"].includes(item.status)) violations.add("immutable_fact")
      if (operation.gate.risk_level === "high" && operation.gate.validation_mode !== "review_and_user_gate") {
        violations.add("high_risk_gate_required")
      }
      return
    }
    if (
      operation.type === "request_capability" &&
      (!trigger || operation.need.resource_scope.some((scope) => !trigger.resource_scope.includes(scope)))
    ) {
      violations.add("scope_escalation")
    }
  })

  const preview = GraphSnapshot.parse({
    project_id: input.snapshot.project_id,
    revision: input.snapshot.revision + 1,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    dependencies: [...dependencies]
      .map((key) => {
        const [work_item_id, depends_on_id] = key.split("\u0000")
        return { work_item_id, depends_on_id }
      })
      .sort(
        (left, right) =>
          left.work_item_id.localeCompare(right.work_item_id) ||
          left.depends_on_id.localeCompare(right.depends_on_id),
      ),
  })
  if (hasCycle(preview) || hasParentCycle(preview)) violations.add("cycle")
  const verdict = GraphPolicyVerdict.parse({
    result: violations.size ? "rejected" : "allowed",
    violations: [...violations].sort(),
  })
  return { verdict, preview }
}
