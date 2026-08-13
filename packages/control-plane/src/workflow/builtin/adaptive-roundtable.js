export const meta = {
  name: "adaptive-roundtable",
  version: "1",
  description: "Runs a dynamically sized expert roundtable and converges on a structured decision.",
  whenToUse: "Use when a decision benefits from several independent professional perspectives.",
  defaultRuntime: "codex",
  capabilityPacks: ["board-strategy@1"],
  requiredRuntimeCapabilities: ["structuredOutput"],
  phases: [{ title: "Select" }, { title: "Discuss" }, { title: "Converge" }],
}

const topic = typeof args === "string" ? args : args && (args.topic || args.goal)
if (!topic) return { error: "A roundtable topic is required." }
const participants = args && Array.isArray(args.participants) && args.participants.length
  ? args.participants.slice(0, 8)
  : ["product leader", "software architect", "delivery reviewer"]
phase("Discuss")
const views = await parallel(participants.map(role => () => agent(
  "You are the " + role + " in a company roundtable. Give an independent position, evidence, risks and objections on:\n\n" + topic,
  { role, capabilityPacks: ["board-strategy@1"], schema: { type: "object" } },
)))
phase("Converge")
return await agent("Chair this roundtable. Resolve disagreements explicitly and return a decision, rationale, dissent, risks and next actions.\n\nTopic:\n" + topic + "\n\nViews:\n" + JSON.stringify(views), { role: "roundtable-chair", capabilityPacks: ["board-strategy@1"], schema: { type: "object" } })
