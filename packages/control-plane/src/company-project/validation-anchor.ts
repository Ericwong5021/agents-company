import path from "node:path"
import fs from "node:fs/promises"
import { and, desc, eq, inArray } from "drizzle-orm"
import { AgentRunTable } from "@/agent-run/agent-run.sql"
import { Database } from "@/storage"
import {
  CompanyArtifactTable,
  CompanyGraphMutationTable,
  CompanyProjectEventTable,
  CompanyProjectTable,
  CompanyWorkItemDependencyTable,
  CompanyWorkItemTable,
} from "./company-project.sql"
import type {
  ValidationCriterion,
  ValidationEvidence,
  ValidationGate,
  ValidationScalar,
  WorkReceiptEvidenceRef,
} from "./schema"

export type AnchorObservation = {
  criterion_id: string
  anchor: ValidationCriterion["anchor"]["kind"]
  reference: string
  observed: ValidationScalar
  warning?: string
  source_ref?: WorkReceiptEvidenceRef
}

const booleanValue = (content: string) => {
  const matched = content.match(/"(?:exists|available|reachable|ok|present|invariant|accepted)"\s*:\s*(true|false)/i)
  return matched ? matched[1] === "true" : undefined
}

const numericValue = (content: string, key: string) => {
  const matched = content.match(new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*(-?\\d+)`, "i"))
  return matched ? Number(matched[1]) : undefined
}

const stringValue = (content: string, key: string) =>
  content.match(new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"([^"]*)"`, "i"))?.[1]

const artifactValue = (criterion: ValidationCriterion, content: string) => {
  if (criterion.operator === "digest") return new Bun.CryptoHasher("sha256").update(content).digest("hex")
  if (criterion.operator === "exit_code") return numericValue(content, "exit_code") ?? -1
  if (criterion.operator === "exists") return booleanValue(content) ?? content.length > 0
  if (typeof criterion.expected === "boolean") return booleanValue(content) ?? false
  if (typeof criterion.expected === "number")
    return numericValue(content, criterion.id) ?? numericValue(content, "value") ?? Number.MIN_SAFE_INTEGER
  return stringValue(content, criterion.id) ?? stringValue(content, "value") ?? content.trim()
}

const unavailable = (criterion: ValidationCriterion, warning: string): AnchorObservation => ({
  criterion_id: criterion.id,
  anchor: criterion.anchor.kind,
  reference: criterion.anchor.reference,
  observed:
    criterion.operator === "exit_code"
      ? -1
      : criterion.operator === "digest"
        ? "0".repeat(64)
        : typeof criterion.expected === "boolean"
          ? false
          : typeof criterion.expected === "number"
            ? Number.MIN_SAFE_INTEGER
            : "",
  warning,
})

const referenceID = (reference: string, prefix: string) =>
  reference.startsWith(`${prefix}:`) ? reference.slice(prefix.length + 1) : undefined

export async function observeGate(gate: ValidationGate, evidence: ValidationEvidence[] = []) {
  const facts = Database.use((db) => ({
    project: db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, gate.project_id)).get(),
    item: gate.work_item_id
      ? db
          .select()
          .from(CompanyWorkItemTable)
          .where(
            and(eq(CompanyWorkItemTable.project_id, gate.project_id), eq(CompanyWorkItemTable.id, gate.work_item_id)),
          )
          .get()
      : undefined,
    artifacts: db
      .select()
      .from(CompanyArtifactTable)
      .where(eq(CompanyArtifactTable.project_id, gate.project_id))
      .orderBy(desc(CompanyArtifactTable.created_at), desc(CompanyArtifactTable.id))
      .all(),
    runs: db
      .select()
      .from(AgentRunTable)
      .where(eq(AgentRunTable.company_project_id, gate.project_id))
      .orderBy(desc(AgentRunTable.time_created), desc(AgentRunTable.id))
      .all(),
    dependencies: gate.blocking_work_item_ids.length
      ? db
          .select()
          .from(CompanyWorkItemDependencyTable)
          .where(inArray(CompanyWorkItemDependencyTable.work_item_id, gate.blocking_work_item_ids))
          .all()
      : [],
  }))
  if (!facts.project) return gate.criteria.map((criterion) => unavailable(criterion, "project unavailable"))
  const project = facts.project
  const allowedWorkItemIDs = new Set([
    ...(gate.work_item_id ? [gate.work_item_id] : []),
    ...facts.dependencies.map((dependency) => dependency.depends_on_id),
  ])
  return await Promise.all(
    gate.criteria.map(async (criterion): Promise<AnchorObservation> => {
      const hint = evidence.find(
        (candidate) =>
          candidate.criterion_id === criterion.id &&
          candidate.anchor === criterion.anchor.kind &&
          candidate.reference === criterion.anchor.reference,
      )
      const artifactID = referenceID(criterion.anchor.reference, "artifact")
      const hintedArtifactID = hint?.evidence_ref.kind === "artifact" ? hint.evidence_ref.id : undefined
      const artifact = artifactID
        ? facts.artifacts.find((candidate) => candidate.id === artifactID)
        : hintedArtifactID
          ? facts.artifacts.find(
              (candidate) =>
                candidate.id === hintedArtifactID &&
                (!gate.work_item_id ||
                  Boolean(candidate.work_item_id && allowedWorkItemIDs.has(candidate.work_item_id))),
            )
          : facts.artifacts.find((candidate) => !gate.work_item_id || candidate.work_item_id === gate.work_item_id)
      if (criterion.anchor.kind === "artifact") {
        if (!artifact?.content) return unavailable(criterion, "artifact content unavailable")
        return {
          criterion_id: criterion.id,
          anchor: criterion.anchor.kind,
          reference: criterion.anchor.reference,
          observed: artifactValue(criterion, artifact.content),
          source_ref: { kind: "artifact", id: artifact.id },
        }
      }
      if (criterion.anchor.kind === "unit_test" || criterion.anchor.kind === "integration_test") {
        const runID = referenceID(criterion.anchor.reference, "agent_run")
        const hintedRunID = hint?.evidence_ref.kind === "agent_run" ? hint.evidence_ref.id : undefined
        const run = runID
          ? facts.runs.find((candidate) => candidate.id === runID)
          : hintedRunID
            ? facts.runs.find(
                (candidate) =>
                  candidate.id === hintedRunID &&
                  (!gate.work_item_id ||
                    Boolean(candidate.work_item_id && allowedWorkItemIDs.has(candidate.work_item_id))),
              )
            : facts.runs.find((candidate) => !gate.work_item_id || candidate.work_item_id === gate.work_item_id)
        if (run?.exit_code !== null && run?.exit_code !== undefined)
          return {
            criterion_id: criterion.id,
            anchor: criterion.anchor.kind,
            reference: criterion.anchor.reference,
            observed: run.exit_code,
            warning: run.safe_error_summary ?? undefined,
            source_ref: { kind: "agent_run", id: run.id },
          }
        if (!artifact?.content) return unavailable(criterion, "command result unavailable")
        return {
          criterion_id: criterion.id,
          anchor: criterion.anchor.kind,
          reference: criterion.anchor.reference,
          observed: artifactValue(criterion, artifact.content),
          warning: /"warning"\s*:\s*true/i.test(artifact.content) ? "command evidence contains a warning" : undefined,
          source_ref: { kind: "artifact", id: artifact.id },
        }
      }
      if (criterion.anchor.kind === "runtime" || criterion.anchor.kind === "device") {
        const runID = referenceID(criterion.anchor.reference, "agent_run")
        const hintedRunID = hint?.evidence_ref.kind === "agent_run" ? hint.evidence_ref.id : undefined
        const run = runID
          ? facts.runs.find((candidate) => candidate.id === runID)
          : hintedRunID
            ? facts.runs.find(
                (candidate) =>
                  candidate.id === hintedRunID &&
                  (!gate.work_item_id ||
                    Boolean(candidate.work_item_id && allowedWorkItemIDs.has(candidate.work_item_id))),
              )
            : facts.runs.find((candidate) => !gate.work_item_id || candidate.work_item_id === gate.work_item_id)
        if (!run) return unavailable(criterion, "runtime state unavailable")
        return {
          criterion_id: criterion.id,
          anchor: criterion.anchor.kind,
          reference: criterion.anchor.reference,
          observed: criterion.operator === "exists" ? true : run.state,
          warning: run.safe_error_summary ?? undefined,
          source_ref: { kind: "agent_run", id: run.id },
        }
      }
      if (criterion.anchor.kind === "source") {
        if (/^https?:\/\//i.test(criterion.anchor.reference))
          return unavailable(criterion, "HTTP source anchors require an authorized fetch policy")
        const requested = referenceID(criterion.anchor.reference, "file") ?? criterion.anchor.reference
        const resolved = path.resolve(project.output_dir, requested)
        if (
          resolved !== path.resolve(project.output_dir) &&
          !resolved.startsWith(`${path.resolve(project.output_dir)}${path.sep}`)
        )
          return unavailable(criterion, "source path exceeds project workspace")
        const file = Bun.file(resolved)
        const exists = await file.exists()
        const [workspaceRealPath, sourceRealPath] = await Promise.all([
          fs.realpath(project.output_dir).catch(() => undefined),
          exists ? fs.realpath(resolved).catch(() => undefined) : undefined,
        ])
        if (
          !workspaceRealPath ||
          !sourceRealPath ||
          (sourceRealPath !== workspaceRealPath && !sourceRealPath.startsWith(`${workspaceRealPath}${path.sep}`))
        )
          return unavailable(criterion, "source file resolves outside project workspace")
        return {
          criterion_id: criterion.id,
          anchor: criterion.anchor.kind,
          reference: criterion.anchor.reference,
          observed:
            criterion.operator === "digest" && exists
              ? new Bun.CryptoHasher("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex")
              : exists,
          warning: exists ? undefined : "source file unavailable",
        }
      }
      const graph = criterion.anchor.reference.match(/^graph:([^:]+):([^:]+)$/)
      if (graph) {
        const mutation = Database.use((db) =>
          db
            .select()
            .from(CompanyGraphMutationTable)
            .where(
              and(
                eq(CompanyGraphMutationTable.id, graph[1]!),
                eq(CompanyGraphMutationTable.project_id, gate.project_id),
              ),
            )
            .get(),
        )
        return {
          criterion_id: criterion.id,
          anchor: criterion.anchor.kind,
          reference: criterion.anchor.reference,
          observed: mutation?.status === "applied" && facts.item?.id === graph[2],
          warning: mutation?.status === "applied" ? undefined : "graph mutation is not applied",
        }
      }
      const eventID = referenceID(criterion.anchor.reference, "project_event")
      if (eventID) {
        const event = Database.use((db) =>
          db
            .select()
            .from(CompanyProjectEventTable)
            .where(
              and(eq(CompanyProjectEventTable.id, eventID), eq(CompanyProjectEventTable.project_id, gate.project_id)),
            )
            .get(),
        )
        if (!event) return unavailable(criterion, "project event unavailable")
        return {
          criterion_id: criterion.id,
          anchor: criterion.anchor.kind,
          reference: criterion.anchor.reference,
          observed: criterion.operator === "exists" ? true : event.type,
          source_ref: { kind: "project_event", id: event.id },
        }
      }
      if (!artifact?.content) return unavailable(criterion, "fact evidence unavailable")
      return {
        criterion_id: criterion.id,
        anchor: criterion.anchor.kind,
        reference: criterion.anchor.reference,
        observed: artifactValue(criterion, artifact.content),
        source_ref: { kind: "artifact", id: artifact.id },
      }
    }),
  )
}
