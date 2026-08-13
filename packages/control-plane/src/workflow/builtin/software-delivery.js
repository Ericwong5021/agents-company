export const meta = {
  name: "software-delivery",
  version: "1",
  description: "Plans, implements, verifies, independently reviews and governs one software delivery assignment.",
  defaultRuntime: "codex",
  capabilityPacks: ["technical-planning@1", "software-implementation@1", "verification-testing@1", "independent-review@1", "delivery-governance@1"],
  requiredRuntimeCapabilities: ["toolCalls", "structuredOutput", "workspaceRead", "workspaceWrite"],
  phases: [{ title: "Plan" }, { title: "Implement" }, { title: "Verify" }, { title: "Review" }, { title: "Gate" }],
}

const assignment = typeof args === "string" ? args : JSON.stringify(args || {})
if (!assignment) return { error: "A delivery assignment is required." }
phase("Plan")
const plan = await agent("Inspect the repository and produce a decision-complete implementation plan for:\n\n" + assignment, { role: "technical-planner", capabilityPacks: ["technical-planning@1"], schema: { type: "object" } })
if (!plan) return { status: "failed", stage: "plan" }
phase("Implement")
const implementation = await agent("Implement this approved assignment in the isolated worktree. Return changed files and evidence.\n\nAssignment:\n" + assignment + "\n\nPlan:\n" + JSON.stringify(plan), { role: "implementation-engineer", capabilityPacks: ["software-implementation@1"], isolation: "worktree", schema: { type: "object" } })
if (!implementation) return { status: "failed", stage: "implementation", plan }
const deliveryWorkspace = implementation._worktree && implementation._worktree.directory
if (!deliveryWorkspace) return { status: "failed", stage: "worktree", plan, implementation }
phase("Verify")
const verification = await agent("Verify the implementation against the assignment and repository instructions. Preserve command evidence.\n\n" + JSON.stringify({ assignment, implementation }), { role: "verification-engineer", capabilityPacks: ["verification-testing@1"], workspace: deliveryWorkspace, schema: { type: "object" } })
phase("Review")
const review = await agent("Independently review the implementation and verification evidence. Return approve or reject with findings.\n\n" + JSON.stringify({ assignment, implementation, verification }), { role: "independent-reviewer", capabilityPacks: ["independent-review@1"], workspace: deliveryWorkspace, schema: { type: "object" } })
phase("Gate")
return await agent("Apply delivery governance. Completion is allowed only when verification passed and review approved.\n\n" + JSON.stringify({ assignment, plan, implementation, verification, review }), { role: "delivery-governor", capabilityPacks: ["delivery-governance@1"], schema: { type: "object" } })
