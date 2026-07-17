export const meta = {
  name: "independent-review",
  version: "1",
  description: "Reviews a software change in an isolated reviewer context and returns a gate decision.",
  defaultRuntime: "pi",
  capabilityPacks: ["independent-review@1"],
  requiredRuntimeCapabilities: ["toolCalls", "structuredOutput", "workspaceRead"],
  phases: [{ title: "Review" }],
}

const assignment = typeof args === "string" ? args : JSON.stringify(args || {})
phase("Review")
return await agent("Independently review this assignment and its current worktree. Return findings with severity and evidence, followed by approve or reject.\n\n" + assignment, { role: "independent-reviewer", capabilityPacks: ["independent-review@1"], isolation: "worktree", schema: { type: "object" } })
