import { CompanyID } from "../../src/company/schema"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage"
import {
  identitySnapshot,
  runAgents,
  runRecruitment,
  seedB0Project,
} from "./b0-fixture"

const phase = process.argv[2]
const directory = process.argv[3]

if (!phase || !directory) throw new Error("Expected phase and workspace directory")

const history = () =>
  runRecruitment((service) =>
    service.listAssignments({
      project_id: "cprj_b0_reassign",
      work_item_id: "cwi_b0_reassign",
    }),
  )

const result = await Instance.provide({
  directory,
  fn: async () => {
    if (phase === "inspect") {
      const inspect = async () => {
        const assignments = await history()
        return {
          assignments,
          currentAssignments: assignments.filter(
            (assignment) => assignment.status === "assigned" || assignment.status === "active",
          ).length,
          identities: Object.fromEntries(
            ["b0-reassign-a", "b0-reassign-b", "b0-reassign-c", "b0-reassign-d"].map((id) => [
              id,
              identitySnapshot(id),
            ]),
          ),
        }
      }
      const first = await inspect()
      Database.close()
      return { restarts: [first, await inspect()] }
    }
    if (phase !== "seed") throw new Error(`Unknown probe phase: ${phase}`)
    const companyID = CompanyID.parse("cmp_b0_reassign")
    seedB0Project({
      companyID,
      projectID: "cprj_b0_reassign",
      workItemID: "cwi_b0_reassign",
      role: "recovery analyst",
    })
    for (const id of ["b0-reassign-a", "b0-reassign-b", "b0-reassign-c", "b0-reassign-d"])
      await runAgents((service) =>
        service.create({
          id,
          company_id: companyID,
          name: id,
          lifecycle: id === "b0-reassign-a" ? "employee" : "candidate",
          role_key: id === "b0-reassign-a" ? "permanent-recovery-owner" : undefined,
          preferred_runtime: "codex",
          responsibilities: ["recovery analyst", "analysis", "research"],
        }),
      )
    const identities = Object.fromEntries(
      ["b0-reassign-a", "b0-reassign-b", "b0-reassign-c", "b0-reassign-d"].map((id) => [
        id,
        identitySnapshot(id),
      ]),
    )
    const need = await runRecruitment((service) =>
      service.createNeed({
        company_id: companyID,
        project_id: "cprj_b0_reassign",
        work_item_id: "cwi_b0_reassign",
        need_key: "recovery-owner",
        role: "recovery analyst",
        work_type: "analysis",
        capability_packs: ["research-analysis@1"],
        risk_level: "medium",
        demand_horizon: "project",
        required_runtime_capabilities: ["structuredOutput", "workspaceRead"],
        required_tools: ["read"],
        allowed_permission_modes: ["read_only"],
        workspace_scopes: ["artifacts/recovery"],
        independent_from_agent_ids: [],
      }),
    )
    const initial = await runRecruitment((service) =>
      service.selectAndAssign({
        capability_need_id: need.id,
        exclude_agent_ids: [],
        required_agent_id: "b0-reassign-a",
      }),
    )
    const second = await runRecruitment((service) =>
      service.reassign({
        work_item_id: "cwi_b0_reassign",
        owner_agent_id: "b0-reassign-b",
        reason: "Replace the initial project responsibility",
        expected_assignment_id: initial.assignment.id,
        idempotency_key: "b0-reassign-to-b",
      }),
    )
    const replay = await runRecruitment((service) =>
      service.reassign({
        work_item_id: "cwi_b0_reassign",
        owner_agent_id: "b0-reassign-b",
        reason: "Replace the initial project responsibility",
        expected_assignment_id: initial.assignment.id,
        idempotency_key: "b0-reassign-to-b",
      }),
    )
    const contention = await Promise.allSettled(
      ["b0-reassign-c", "b0-reassign-d"].map((owner) =>
        runRecruitment((service) =>
          service.reassign({
            work_item_id: "cwi_b0_reassign",
            owner_agent_id: owner,
            reason: `Concurrent reassignment to ${owner}`,
            expected_assignment_id: second.id,
            idempotency_key: `contention-${owner}`,
          }),
        ),
      ),
    )
    const assignments = await history()
    return {
      assignments,
      initialAssignmentId: initial.assignment.id,
      secondAssignmentId: second.id,
      replayAssignmentId: replay.id,
      contention: {
        fulfilled: contention.filter((item) => item.status === "fulfilled").length,
        rejected: contention.filter((item) => item.status === "rejected").length,
      },
      currentAssignments: assignments.filter(
        (assignment) => assignment.status === "assigned" || assignment.status === "active",
      ).length,
      identities,
    }
  },
})

Database.close()
console.log(JSON.stringify(result))
