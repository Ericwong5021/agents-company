import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { CompanyProject } from "../../src/company-project"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(CompanyProject.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("CompanyProject execution state machine", () => {
  it.live("enforces artifacts, dependencies, and both human gates before repository creation", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const project = yield* service.create({
          goal: "Research AI mini-games and build a playable text-game MVP",
          title: "AI text game MVP",
          owner_agent_id: "chief-of-staff",
        })

        expect(project.status).toBe("intake")
        expect(path.basename(project.output_dir)).toBe(project.id)
        const repositoryBeforeApproval = yield* Effect.exit(service.initRepository(project.id))
        expect(Exit.isFailure(repositoryBeforeApproval)).toBe(true)
        if (Exit.isFailure(repositoryBeforeApproval))
          expect(Cause.pretty(repositoryBeforeApproval.cause)).toMatch(/Development approval/)

        yield* service.transition({ id: project.id, status: "researching" })
        const researchPlan = yield* service.createPlan({
          project_id: project.id,
          phase: "research",
          summary: "Parallel market, audience, and technical research",
          acceptance_criteria: ["Evidence-backed recommendation", "Choose delivery surface"],
        })
        const market = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: researchPlan.id,
          title: "Market research",
          description: "Research demand and competitors",
          kind: "research",
          owner_agent_id: "market-researcher",
          acceptance_criteria: ["Cited findings"],
        })
        const proposal = yield* service.createWorkItem({
          project_id: project.id,
          plan_id: researchPlan.id,
          title: "Investment proposal",
          description: "Synthesize the research into a go/no-go proposal",
          kind: "synthesis",
          owner_agent_id: "product-lead",
          acceptance_criteria: ["Clear recommendation"],
          depends_on: [market.id],
        })

        expect((yield* service.readyWorkItems(project.id)).map((item) => item.id)).toEqual([market.id])
        yield* service.startWorkItem(market.id)
        const completionWithoutArtifact = yield* Effect.exit(service.completeWorkItem(market.id))
        expect(Exit.isFailure(completionWithoutArtifact)).toBe(true)
        if (Exit.isFailure(completionWithoutArtifact))
          expect(Cause.pretty(completionWithoutArtifact.cause)).toMatch(/without an artifact/)
        yield* service.addArtifact({
          project_id: project.id,
          work_item_id: market.id,
          kind: "research_report",
          title: "Market report",
          path: "artifacts/research/market.md",
          content: "# Market report\n",
          evidence: { sources: 3 },
          created_by_agent_id: "market-researcher",
        })
        yield* service.completeWorkItem(market.id)
        expect((yield* service.readyWorkItems(project.id)).map((item) => item.id)).toEqual([proposal.id])

        const projectGate = yield* service.requestGate({
          project_id: project.id,
          kind: "project_approval",
          title: "Approve project",
          summary: "Recommend building a browser-based text game",
        })
        expect((yield* service.get(project.id))?.status).toBe("awaiting_project_approval")
        const repositoryBeforeDevelopment = yield* Effect.exit(service.initRepository(project.id))
        expect(Exit.isFailure(repositoryBeforeDevelopment)).toBe(true)
        if (Exit.isFailure(repositoryBeforeDevelopment))
          expect(Cause.pretty(repositoryBeforeDevelopment.cause)).toMatch(/Development approval/)
        yield* service.resolveGate({ id: projectGate.id, decision: "approve" })
        expect((yield* service.get(project.id))?.status).toBe("planning")

        yield* service.createPlan({
          project_id: project.id,
          phase: "development",
          summary: "Implement and verify the approved MVP",
          acceptance_criteria: ["Installs", "Tests pass", "Playable"],
        })
        const developmentGate = yield* service.requestGate({
          project_id: project.id,
          kind: "development_approval",
          title: "Approve development",
          summary: "Approve PRD, architecture, and acceptance criteria",
        })
        yield* service.resolveGate({ id: developmentGate.id, decision: "approve" })
        const repo = yield* service.initRepository(project.id)
        expect(yield* Effect.promise(() => Bun.file(path.join(repo, ".git", "HEAD")).exists())).toBe(true)
        expect((yield* service.get(project.id))?.status).toBe("developing")
      }),
    ),
  )

  it.live("rejecting a gate stops the project", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const service = yield* CompanyProject.Service
        const project = yield* service.create({ goal: "Build a game" })
        yield* service.transition({ id: project.id, status: "researching" })
        const gate = yield* service.requestGate({
          project_id: project.id,
          kind: "project_approval",
          title: "Approve project",
          summary: "Proposal",
        })
        yield* service.resolveGate({ id: gate.id, decision: "reject", note: "Not enough evidence" })
        expect((yield* service.get(project.id))?.status).toBe("rejected")
      }),
    ),
  )
})
