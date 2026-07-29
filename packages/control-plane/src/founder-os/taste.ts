import { and, asc, desc, eq } from "drizzle-orm"
import {
  FounderCalibrationItem,
  FounderCalibrationRequestInput,
  FounderCalibrationResponseInput,
  FounderCaseImportInput,
  FounderRubricValidation,
  FounderRubricValidationInput,
  type FounderCalibrationRequestInput as FounderCalibrationRequestInputValue,
  type FounderCalibrationResponseInput as FounderCalibrationResponseInputValue,
  type FounderCaseImportInput as FounderCaseImportInputValue,
  type FounderRubricValidationInput as FounderRubricValidationInputValue,
} from "@agents-company/shared/founder-os"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import { GovernanceAssetSelectionTable, GovernanceAssetTable } from "./asset.sql"
import * as FounderOSAsset from "./asset"
import { FounderCalibrationRequestTable, FounderCalibrationResponseTable } from "./shadow.sql"

export function importCase(raw: FounderCaseImportInputValue) {
  const input = FounderCaseImportInput.parse(raw)
  if (
    (input.kind === "taste_reference" || input.kind === "taste_anti_reference")
    && !input.sourceRefs.some((reference) => reference.kind === "artifact")
  )
    throw new Error("Taste cases require an original artifact reference")
  return FounderOSAsset.createDraft({
    companyId: input.companyId,
    type: input.kind,
    scope: input.scope,
    content: input.kind === "rubric"
      ? JSON.stringify({ description: input.content, dimensions: input.dimensions })
      : input.content,
    rationale: input.rationale,
    tags: input.dimensions,
    authority: input.authority,
    sourceRefs: input.sourceRefs,
    createdBy: input.createdBy,
  })
}

function calibrationFromRows(
  request: typeof FounderCalibrationRequestTable.$inferSelect,
  response?: typeof FounderCalibrationResponseTable.$inferSelect,
) {
  return FounderCalibrationItem.parse({
    id: request.id,
    companyId: request.company_id,
    kind: request.kind,
    scope: { kind: request.scope_kind, ...(request.scope_ref ? { ref: request.scope_ref } : {}) },
    prompt: request.prompt,
    candidates: JSON.parse(request.candidates_json),
    status: response ? "responded" : "pending",
    ...(response
      ? {
          response: response.response,
          reason: response.reason,
          confirmationEventId: response.confirmation_event_id,
          confirmedBy: response.confirmed_by,
        }
      : {}),
    createdBy: request.created_by,
    createdAt: request.created_at,
  })
}

export function calibrationItems(companyId: string) {
  const responses = new Map(
    Database.use((db) =>
      db
        .select()
        .from(FounderCalibrationResponseTable)
        .where(eq(FounderCalibrationResponseTable.company_id, companyId))
        .orderBy(asc(FounderCalibrationResponseTable.created_at))
        .all(),
    ).map((row) => [row.request_id, row]),
  )
  return Database.use((db) =>
    db
      .select()
      .from(FounderCalibrationRequestTable)
      .where(eq(FounderCalibrationRequestTable.company_id, companyId))
      .orderBy(desc(FounderCalibrationRequestTable.created_at))
      .limit(100)
      .all(),
  ).map((request) => calibrationFromRows(request, responses.get(request.id)))
}

export function enqueueCalibration(raw: FounderCalibrationRequestInputValue) {
  const input = FounderCalibrationRequestInput.parse(raw)
  if (input.kind !== "ab" && input.candidates.length !== 1)
    throw new Error("Accept and reject calibration require exactly one candidate")
  const id = Identifier.create("fcal", "ascending")
  Database.transaction((db) =>
    db.insert(FounderCalibrationRequestTable)
      .values({
        id,
        company_id: input.companyId,
        kind: input.kind,
        scope_kind: input.scope.kind,
        scope_ref: input.scope.ref ?? null,
        prompt: input.prompt,
        candidates_json: JSON.stringify(input.candidates),
        created_by: input.createdBy,
        created_at: Date.now(),
      })
      .run(),
  )
  return calibrationFromRows(Database.use((db) =>
    db.select().from(FounderCalibrationRequestTable).where(eq(FounderCalibrationRequestTable.id, id)).get()!,
  ))
}

export function respondCalibration(raw: FounderCalibrationResponseInputValue) {
  const input = FounderCalibrationResponseInput.parse(raw)
  const request = Database.use((db) =>
    db
      .select()
      .from(FounderCalibrationRequestTable)
      .where(and(
        eq(FounderCalibrationRequestTable.id, input.requestId),
        eq(FounderCalibrationRequestTable.company_id, input.companyId),
      ))
      .get(),
  )
  if (!request) throw new Error("Calibration request was not found")
  if (request.kind === "ab" && input.response !== "prefer_first" && input.response !== "prefer_second")
    throw new Error("A/B calibration requires a preference response")
  if (request.kind !== "ab" && input.response !== "accept" && input.response !== "reject")
    throw new Error("Single-candidate calibration requires accept or reject")
  const id = Identifier.create("fcalr", "ascending")
  Database.transaction((db) =>
    db.insert(FounderCalibrationResponseTable)
      .values({
        id,
        company_id: input.companyId,
        request_id: input.requestId,
        response: input.response,
        reason: input.reason,
        confirmation_event_id: input.confirmationEventId,
        confirmed_by: input.confirmedBy,
        created_at: Date.now(),
      })
      .run(),
  )
  return calibrationFromRows(
    request,
    Database.use((db) =>
      db.select().from(FounderCalibrationResponseTable).where(eq(FounderCalibrationResponseTable.id, id)).get()!,
    ),
  )
}

export function validateRubric(raw: FounderRubricValidationInputValue) {
  const input = FounderRubricValidationInput.parse(raw)
  const rubric = Database.use((db) =>
    db
      .select()
      .from(GovernanceAssetTable)
      .where(and(
        eq(GovernanceAssetTable.id, input.rubric.assetId),
        eq(GovernanceAssetTable.version, input.rubric.version),
        eq(GovernanceAssetTable.company_id, input.companyId),
        eq(GovernanceAssetTable.type, "rubric"),
      ))
      .get(),
  )
  if (!rubric)
    return FounderRubricValidation.parse({
      status: "blocked",
      rubric: input.rubric,
      scores: input.scores,
      blockReasons: ["rubric_missing"],
    })
  const selected = Database.use((db) =>
    db
      .select()
      .from(GovernanceAssetSelectionTable)
      .where(and(
        eq(GovernanceAssetSelectionTable.company_id, input.companyId),
        eq(GovernanceAssetSelectionTable.asset_id, input.rubric.assetId),
      ))
      .orderBy(desc(GovernanceAssetSelectionTable.created_at), desc(GovernanceAssetSelectionTable.id))
      .get(),
  )
  if (
    selected?.asset_version !== rubric.version
    || rubric.status !== "active"
    || (rubric.authority !== "human_explicit" && rubric.authority !== "human_confirmed")
  )
    return FounderRubricValidation.parse({
      status: "blocked",
      rubric: input.rubric,
      rubricAuthority: rubric.authority,
      scores: input.scores,
      blockReasons: ["rubric_inactive"],
    })
  const parsed = JSON.parse(rubric.content) as unknown
  const dimensions = Array.isArray(parsed)
    ? []
    : typeof parsed === "object" && parsed !== null && "dimensions" in parsed && Array.isArray(parsed.dimensions)
      ? parsed.dimensions.filter((dimension): dimension is string => typeof dimension === "string")
      : []
  const actual = input.scores.map((score) => score.dimension).toSorted()
  if (
    dimensions.length === 0
    || dimensions.toSorted().some((dimension, index) => actual[index] !== dimension)
    || actual.length !== dimensions.length
  )
    return FounderRubricValidation.parse({
      status: "blocked",
      rubric: input.rubric,
      rubricAuthority: rubric.authority,
      scores: input.scores,
      blockReasons: ["dimension_mismatch"],
    })
  return FounderRubricValidation.parse({
    status: "valid",
    rubric: input.rubric,
    rubricAuthority: rubric.authority,
    scores: input.scores,
    aggregate: input.scores.reduce((sum, score) => sum + score.score, 0) / input.scores.length,
    blockReasons: [],
  })
}
