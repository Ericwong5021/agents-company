export const meta = {
  name: "board-charter",
  version: "1",
  description: "Turns a software product goal into an approved, bounded company charter.",
  whenToUse: "Use before planning delivery for a new product goal or a material change of direction.",
  defaultRuntime: "pi",
  capabilityPacks: ["board-strategy@1", "product-charter@1"],
  requiredRuntimeCapabilities: ["structuredOutput", "workspaceRead"],
  phases: [{ title: "Perspectives" }, { title: "Charter" }],
}

const goal = typeof args === "string" ? args : args && args.goal
if (!goal) return { error: "A goal is required." }
phase("Perspectives")
const perspectives = await parallel([
  () => agent("Evaluate this goal as a board strategist:\n\n" + goal, { role: "board-strategist", capabilityPacks: ["board-strategy@1"], schema: { type: "object" } }),
  () => agent("Turn this goal into measurable product outcomes and exclusions:\n\n" + goal, { role: "product-charter-author", capabilityPacks: ["product-charter@1"], schema: { type: "object" } }),
])
phase("Charter")
return await agent("Produce the final company charter from this goal and the two perspectives. Include scope, non-scope, success criteria, risks and approval gates.\n\nGoal:\n" + goal + "\n\nPerspectives:\n" + JSON.stringify(perspectives), { role: "charter-chair", capabilityPacks: ["product-charter@1"], schema: { type: "object" } })
