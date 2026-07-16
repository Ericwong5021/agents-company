export const meta = {
  name: "delivery-recovery",
  version: "1",
  description: "Classifies an interrupted delivery and produces a safe retry, handoff or stop decision.",
  defaultRuntime: "pi",
  capabilityPacks: ["delivery-governance@1"],
  requiredRuntimeCapabilities: ["structuredOutput", "workspaceRead"],
  phases: [{ title: "Triage" }, { title: "Recovery" }],
}

const incident = typeof args === "string" ? args : JSON.stringify(args || {})
phase("Triage")
const triage = await agent("Classify this interrupted delivery as transient, permanent, unsafe or awaiting-human. Identify preserved state and cleanup needs.\n\n" + incident, { role: "recovery-triage", capabilityPacks: ["delivery-governance@1"], schema: { type: "object" } })
phase("Recovery")
return await agent("Choose exactly one recovery action: retry, handoff, stop-and-cleanup, or await-human. Include prerequisites and idempotency safeguards.\n\n" + JSON.stringify({ incident, triage }), { role: "delivery-governor", capabilityPacks: ["delivery-governance@1"], schema: { type: "object" } })
