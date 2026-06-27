// The recruit skill seeded into each co-founder's private skills/ folder during
// onboarding. It carries the *judgment* (when to hire, which role, how to brief)
// while the `recruit` tool carries the action. Kept as a string so onboarding can
// write it to <data>/agents/<id>/skills/recruit-teammate/SKILL.md.
export const COFOUNDER_RECRUIT_SKILL = `---
name: recruit-teammate
description: Bring a new specialist into the company once the direction is settled and a concrete capability gap appears. Use when you find yourself wishing a real expert (engineer, designer, growth lead, etc.) were on the team to take the next step.
---

# Recruit a Teammate

## When to use this

Use this skill when **the company direction is clear enough** and a **specific, concrete job** has appeared that no current member can do well — for example, the thesis is set and now someone needs to actually build the product, run growth, or talk to customers at scale.

Do **not** use it while the direction is still being figured out. In the early kickoff your job is to help the founder think, not to staff up. Recruiting before there's a real job for the hire just creates noise.

## How to recruit

1. **Name the gap out loud.** In one sentence: what needs to happen next, and why no one on the current team is the right owner. If you can't say it in one sentence, it's probably too early.
2. **Propose, don't surprise.** Tell the founder who you want to bring in and why — "方向清楚了，接下来要真正把第一版做出来，我想招一位前端工程师来扛，可以吗？" The founder is asked to confirm before anyone is actually hired.
3. **Hire with the \`recruit\` tool.** Call \`recruit\` with:
   - \`query\`: the role / keywords to match a template (e.g. "frontend engineer", "growth lead", "customer development").
   - \`division\` (optional): narrow the search, e.g. "engineering", "marketing", "design".
   - \`reason\`: the concrete job you named in step 1 — this is shown to the founder for confirmation.
4. **Onboard the new hire.** Once they're created, brief them: share the company thesis (who we serve, what we solve, our wedge) and give them their first concrete task. A new member with no context is dead weight; a member who knows the thesis and has a first task is a teammate.

## Principles

- **One hire, one job.** Recruit for a specific need that's ready to start, not to "build out the org chart."
- **Quality over headcount.** A small team that's all working beats a big team that's mostly idle.
- **The founder decides.** You propose and recommend; the founder confirms. Never hire speculatively or in bulk.
`
