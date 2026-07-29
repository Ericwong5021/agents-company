import { isIP } from "node:net"
import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, inArray, or } from "drizzle-orm"
import z from "zod"
import { CompanyTable } from "@/company/company.sql"
import { CompanyID } from "@/company/schema"
import {
  CompanyArtifactTable,
  CompanyProjectTable,
} from "@/company-project/company-project.sql"
import { Identifier } from "@/id/id"
import { Database } from "@/storage"
import {
  CompanyCommonsChunkTable,
  CompanyCommonsSourceTable,
} from "./company-commons.sql"
import {
  CommonsAccess,
  CommonsCapability,
  CommonsChunk,
  CommonsSearchHit,
  CommonsSource,
  CommonsSourceDetail,
  CommonsSourceSubmission,
  CommonsSourceType,
  type CommonsAccess as CommonsAccessValue,
  type CommonsCapability as CommonsCapabilityValue,
  type CommonsSearchHit as CommonsSearchHitValue,
  type CommonsSource as CommonsSourceValue,
  type CommonsSourceDetail as CommonsSourceDetailValue,
  type CommonsSourceSubmission as CommonsSourceSubmissionValue,
} from "./schema"

const MAX_MEDIA_BYTES = 20_000_000
const URL_POLICY = {
  timeout_ms: 10_000,
  max_bytes: 10_000_000,
  max_redirects: 3,
  allowed_mime_types: [
    "text/plain",
    "text/markdown",
    "text/html",
    "application/json",
    "application/pdf",
  ],
} as const

const transcriptTypes = new Set<CommonsSourceType>(["image", "podcast", "video"])
const builtInTypes = new Set<CommonsSourceType>(["text", "markdown", "conversation_export"])

class BlockedSourceError extends Error {}

export type AdapterInput = {
  source: CommonsSourceValue
  artifact_content: string
  policy: typeof URL_POLICY
}

export type AdapterOutput = {
  text: string
  artifact_content?: string
  spans?: Array<{ start_offset: number; end_offset: number; locator: Record<string, unknown> }>
  fetch?: {
    final_url: string
    mime_type: string
    byte_length: number
    elapsed_ms: number
    redirects: number
    resolved_addresses: string[]
  }
}

export type CommonsAdapter = {
  id: string
  version: string
  source_types: CommonsSourceType[]
  process: (input: AdapterInput) => Promise<AdapterOutput>
}

export type EmbeddingAdapter = {
  id: string
  embed: (texts: string[]) => Promise<number[][]>
}

const sha256 = (value: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex")

const normalizedHash = (value: string) =>
  sha256(value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim())

const sourceFromRow = (row: typeof CompanyCommonsSourceTable.$inferSelect) =>
  CommonsSource.parse({
    ...row,
    project_id: row.project_id ?? undefined,
    private_owner_id: row.private_owner_id ?? undefined,
    author: row.author ?? undefined,
    origin: row.origin ?? undefined,
    published_at: row.published_at ?? undefined,
    language: row.language ?? undefined,
    tags: JSON.parse(row.tags_json),
    content_hash: row.content_hash ?? undefined,
    normalized_content_hash: row.normalized_content_hash ?? undefined,
    duplicate_of_source_id: row.duplicate_of_source_id ?? undefined,
    deduplication_kind: row.deduplication_kind ?? undefined,
    metadata: JSON.parse(row.metadata_json),
    adapter_id: row.adapter_id ?? undefined,
    adapter_version: row.adapter_version ?? undefined,
    error_code: row.error_code ?? undefined,
    error_message: row.error_message ?? undefined,
  })

const chunkFromRow = (row: typeof CompanyCommonsChunkTable.$inferSelect) =>
  CommonsChunk.parse({
    ...row,
    source_span: JSON.parse(row.source_span_json),
  })

const isPrivateIPv4 = (address: string) => {
  const octets = address.split(".").map(Number)
  return (
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 198 && octets[1] >= 18 && octets[1] <= 19) ||
    octets[0]! >= 224
  )
}

const isPrivateAddress = (address: string) => {
  if (isIP(address) === 4) return isPrivateIPv4(address)
  if (isIP(address) !== 6) return true
  const normalized = address.toLowerCase().split("%")[0]!
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2001:10:") ||
    normalized.startsWith("2001:2:")
  )
}

export function validateURLTarget(value: string) {
  if (!URL.canParse(value)) throw new BlockedSourceError("Commons URL is invalid")
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new BlockedSourceError("Commons URL must use HTTP or HTTPS without credentials")
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1")
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isIP(hostname) > 0 && isPrivateAddress(hostname)
  )
    throw new BlockedSourceError("Commons URL resolves to a blocked local or private target")
  url.hash = ""
  return url.toString()
}

const validateFetchEvidence = (output: AdapterOutput) => {
  if (!output.fetch) throw new BlockedSourceError("URL adapter did not provide fetch security evidence")
  if (output.artifact_content === undefined)
    throw new BlockedSourceError("URL adapter did not preserve fetched source bytes")
  validateURLTarget(output.fetch.final_url)
  if (
    output.fetch.resolved_addresses.length === 0 ||
    output.fetch.resolved_addresses.some(isPrivateAddress)
  )
    throw new BlockedSourceError("URL adapter resolved a blocked local or private address")
  if (!URL_POLICY.allowed_mime_types.includes(output.fetch.mime_type as (typeof URL_POLICY.allowed_mime_types)[number]))
    throw new BlockedSourceError("URL adapter returned a blocked MIME type")
  if (output.fetch.byte_length < 0 || output.fetch.byte_length > URL_POLICY.max_bytes)
    throw new BlockedSourceError("URL adapter response exceeds the size limit")
  if (output.fetch.byte_length !== Buffer.byteLength(output.artifact_content))
    throw new BlockedSourceError("URL adapter byte evidence does not match the preserved source")
  if (output.fetch.elapsed_ms < 0 || output.fetch.elapsed_ms > URL_POLICY.timeout_ms)
    throw new BlockedSourceError("URL adapter exceeded the timeout limit")
  if (output.fetch.redirects < 0 || output.fetch.redirects > URL_POLICY.max_redirects)
    throw new BlockedSourceError("URL adapter exceeded the redirect limit")
}

const visibleWhere = (access: CommonsAccessValue) =>
  and(
    eq(CompanyCommonsSourceTable.company_id, access.company_id),
    or(
      eq(CompanyCommonsSourceTable.privacy_scope, "company"),
      ...(access.project_ids.length
        ? [
            and(
              eq(CompanyCommonsSourceTable.privacy_scope, "project"),
              inArray(CompanyCommonsSourceTable.project_id, access.project_ids),
            ),
          ]
        : []),
      ...(access.private_owner_id
        ? [
            and(
              eq(CompanyCommonsSourceTable.privacy_scope, "private"),
              eq(CompanyCommonsSourceTable.private_owner_id, access.private_owner_id),
            ),
          ]
        : []),
    ),
  )

const scopeMatch = (
  row: typeof CompanyCommonsSourceTable.$inferSelect,
  input: {
    privacy_scope: string
    project_id?: string
    private_owner_id?: string
  },
) =>
  row.privacy_scope === input.privacy_scope &&
  row.project_id === (input.project_id ?? null) &&
  row.private_owner_id === (input.private_owner_id ?? null)

const sourceChunks = (
  source_id: string,
  content: string,
  spans: AdapterOutput["spans"] = [],
) => {
  const chunks: Array<{
    id: string
    source_id: string
    ordinal: number
    body: string
    content_hash: string
    start_offset: number
    end_offset: number
    source_span_json: string
    trust_class: "untrusted_source"
    created_at: number
  }> = []
  const created_at = Date.now()
  let start = 0
  while (start < content.length) {
    const target = Math.min(start + 1_200, content.length)
    const nearby = content.lastIndexOf("\n", target)
    const end = nearby > start + 700 ? nearby : target
    const rawBody = content.slice(start, end)
    const leading = rawBody.length - rawBody.trimStart().length
    const trailing = rawBody.length - rawBody.trimEnd().length
    const body = rawBody.trim()
    if (body)
      chunks.push({
        id: Identifier.ascending("commonsChunk"),
        source_id,
        ordinal: chunks.length,
        body,
        content_hash: sha256(body),
        start_offset: start + leading,
        end_offset: end - trailing,
        source_span_json: JSON.stringify({
          start_offset: start + leading,
          end_offset: end - trailing,
          adapters: spans.filter(
            (span) => span.end_offset > start + leading && span.start_offset < end - trailing,
          ),
        }),
        trust_class: "untrusted_source",
        created_at,
      })
    if (end === content.length) break
    start = Math.max(end - 160, start + 1)
  }
  return chunks
}

const mediaTypeAllowed = (source_type: CommonsSourceType, media_type: string) => {
  if (source_type === "pdf") return media_type === "application/pdf"
  if (source_type === "image") return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(media_type)
  if (source_type === "podcast")
    return ["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/webm"].includes(media_type)
  if (source_type === "video") return ["video/mp4", "video/webm", "video/quicktime"].includes(media_type)
  return true
}

export interface Interface {
  readonly capabilities: () => Effect.Effect<CommonsCapabilityValue[]>
  readonly importSource: (input: CommonsSourceSubmissionValue) => Effect.Effect<CommonsSourceValue>
  readonly retry: (id: string, access: CommonsAccessValue) => Effect.Effect<CommonsSourceValue>
  readonly get: (id: string, access: CommonsAccessValue) => Effect.Effect<CommonsSourceDetailValue | undefined>
  readonly list: (
    access: CommonsAccessValue,
    page?: { limit: number; offset: number },
  ) => Effect.Effect<CommonsSourceValue[]>
  readonly search: (
    query: string,
    access: CommonsAccessValue,
    limit?: number,
  ) => Effect.Effect<CommonsSearchHitValue[]>
  readonly recover: () => Effect.Effect<{ recovered_source_ids: string[] }>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/CompanyCommons") {}

export function makeLayer(options: {
  adapters?: CommonsAdapter[]
  embedding?: EmbeddingAdapter
} = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const adapters = new Map(
        (options.adapters ?? []).flatMap((adapter) =>
          adapter.source_types.map((source_type) => [source_type, adapter] as const),
        ),
      )

      const capabilities = Effect.fn("CompanyCommons.capabilities")(function* () {
        return CommonsCapability.array().parse(
          CommonsSourceType.options.map((source_type) => {
            const adapter = adapters.get(source_type)
            return {
              source_type,
              status: builtInTypes.has(source_type) || adapter ? "available" : "adapter_required",
              adapter_id: adapter?.id,
              supports_transcript: transcriptTypes.has(source_type),
            }
          }),
        )
      })

      const list = Effect.fn("CompanyCommons.list")(function* (
        rawAccess: CommonsAccessValue,
        page = { limit: 51, offset: 0 },
      ) {
        const access = CommonsAccess.parse(rawAccess)
        return Database.use((db) =>
          db
            .select()
            .from(CompanyCommonsSourceTable)
            .where(visibleWhere(access))
            .orderBy(desc(CompanyCommonsSourceTable.updated_at), desc(CompanyCommonsSourceTable.id))
            .limit(page.limit)
            .offset(page.offset)
            .all()
            .map(sourceFromRow),
        )
      })

      const get = Effect.fn("CompanyCommons.get")(function* (
        id: string,
        rawAccess: CommonsAccessValue,
      ) {
        const access = CommonsAccess.parse(rawAccess)
        const row = Database.use((db) =>
          db
            .select()
            .from(CompanyCommonsSourceTable)
            .where(and(eq(CompanyCommonsSourceTable.id, id), visibleWhere(access)))
            .get(),
        )
        if (!row) return
        const artifact = Database.use((db) =>
          db.select().from(CompanyArtifactTable).where(eq(CompanyArtifactTable.id, row.artifact_id)).get(),
        )
        if (!artifact) throw new Error(`Commons source ${id} has no original Artifact`)
        return CommonsSourceDetail.parse({
          source: sourceFromRow(row),
          artifact: {
            ...artifact,
            project_id: artifact.project_id ?? undefined,
            company_id: artifact.company_id ?? undefined,
            private_owner_id: artifact.private_owner_id ?? undefined,
            content: artifact.content ?? undefined,
            evidence: JSON.parse(artifact.evidence_json),
          },
          chunks: Database.use((db) =>
            db
              .select()
              .from(CompanyCommonsChunkTable)
              .where(eq(CompanyCommonsChunkTable.source_id, id))
              .orderBy(asc(CompanyCommonsChunkTable.ordinal))
              .all()
              .map(chunkFromRow),
          ),
        })
      })

      const setFailure = (
        id: string,
        status: "failed" | "blocked" | "unsupported",
        code: string,
        message: string,
      ) => {
        Database.use((db) =>
          db
            .update(CompanyCommonsSourceTable)
            .set({
              ingestion_status: status,
              transcript_status: transcriptTypes.has(
                db
                  .select({ source_type: CompanyCommonsSourceTable.source_type })
                  .from(CompanyCommonsSourceTable)
                  .where(eq(CompanyCommonsSourceTable.id, id))
                  .get()!.source_type as CommonsSourceType,
              )
                ? status
                : "not_applicable",
              error_code: code,
              error_message: message,
              updated_at: Date.now(),
            })
            .where(eq(CompanyCommonsSourceTable.id, id))
            .run(),
        )
      }

      const finish = (source: CommonsSourceValue, content: string, output?: AdapterOutput) => {
        if (
          output?.spans?.some(
            (span) =>
              span.start_offset < 0 ||
              span.end_offset < span.start_offset ||
              span.end_offset > content.length,
          )
        )
          throw new Error("Commons adapter returned an invalid source span")
        const artifactContent = output?.artifact_content ?? Database.use((db) =>
          db
            .select({ content: CompanyArtifactTable.content })
            .from(CompanyArtifactTable)
            .where(eq(CompanyArtifactTable.id, source.artifact_id))
            .get()!.content!,
        )
        const rawHash = sha256(artifactContent)
        const normalized_content_hash = normalizedHash(content)
        Database.transaction((db) => {
          if (output?.artifact_content !== undefined)
            db
              .update(CompanyArtifactTable)
              .set({ content: artifactContent })
              .where(eq(CompanyArtifactTable.id, source.artifact_id))
              .run()
          const exact = db
            .select()
            .from(CompanyCommonsSourceTable)
            .where(
              and(
                eq(CompanyCommonsSourceTable.company_id, source.company_id),
                eq(CompanyCommonsSourceTable.content_hash, rawHash),
              ),
            )
            .all()
            .find((row) => row.id !== source.id && scopeMatch(row, source))
          const normalized = exact
            ? undefined
            : db
                .select()
                .from(CompanyCommonsSourceTable)
                .where(
                  and(
                    eq(CompanyCommonsSourceTable.company_id, source.company_id),
                    eq(CompanyCommonsSourceTable.normalized_content_hash, normalized_content_hash),
                  ),
                )
                .all()
                .find((row) => row.id !== source.id && scopeMatch(row, source))
          db.delete(CompanyCommonsChunkTable).where(eq(CompanyCommonsChunkTable.source_id, source.id)).run()
          const chunks = sourceChunks(source.id, content, output?.spans)
          if (chunks.length) db.insert(CompanyCommonsChunkTable).values(chunks).run()
          db.update(CompanyCommonsSourceTable)
            .set({
              ingestion_status: "ready",
              transcript_status: transcriptTypes.has(source.source_type) ? "ready" : "not_applicable",
              content_hash: rawHash,
              normalized_content_hash,
              duplicate_of_source_id: exact?.id ?? normalized?.id ?? null,
              deduplication_kind: exact ? "exact" : normalized ? "normalized" : null,
              error_code: null,
              error_message: null,
              updated_at: Date.now(),
            })
            .where(eq(CompanyCommonsSourceTable.id, source.id))
            .run()
        })
      }

      const process = Effect.fn("CompanyCommons.process")(function* (source: CommonsSourceValue) {
        if (builtInTypes.has(source.source_type)) {
          const content = Database.use((db) =>
            db
              .select({ content: CompanyArtifactTable.content })
              .from(CompanyArtifactTable)
              .where(eq(CompanyArtifactTable.id, source.artifact_id))
              .get()!.content!,
          )
          finish(source, content)
          return
        }
        const adapter = adapters.get(source.source_type)
        if (!adapter) {
          setFailure(
            source.id,
            "unsupported",
            "adapter_unavailable",
            `No verified ${source.source_type} adapter is configured`,
          )
          return
        }
        Database.use((db) =>
          db
            .update(CompanyCommonsSourceTable)
            .set({
              ingestion_status: "processing",
              transcript_status: transcriptTypes.has(source.source_type) ? "processing" : "not_applicable",
              adapter_id: adapter.id,
              adapter_version: adapter.version,
              updated_at: Date.now(),
            })
            .where(eq(CompanyCommonsSourceTable.id, source.id))
            .run(),
        )
        const output = yield* Effect.promise(() =>
          adapter.process({
            source,
            artifact_content: Database.use((db) =>
              db
                .select({ content: CompanyArtifactTable.content })
                .from(CompanyArtifactTable)
                .where(eq(CompanyArtifactTable.id, source.artifact_id))
                .get()!.content!,
            ),
            policy: URL_POLICY,
          }),
        )
        if (!output.text.trim()) throw new Error("Commons adapter returned empty extracted text")
        if (source.source_type === "url") validateFetchEvidence(output)
        finish(source, output.text, output)
      })

      const importSource = Effect.fn("CompanyCommons.importSource")(function* (
        raw: CommonsSourceSubmissionValue,
      ) {
        const input = CommonsSourceSubmission.parse(raw)
        const company = Database.use((db) =>
          db.select().from(CompanyTable).where(eq(CompanyTable.id, CompanyID.parse(input.company_id))).get(),
        )
        if (!company)
          throw new Error(`Company not found: ${input.company_id}`)
        if (company.company_commons_mode === "off")
          throw new Error("Company Commons is disabled")
        if (
          input.privacy_scope === "project" &&
          !Database.use((db) =>
            db
              .select()
              .from(CompanyProjectTable)
              .where(
                and(
                  eq(CompanyProjectTable.id, input.project_id),
                  eq(CompanyProjectTable.company_id, input.company_id),
                ),
              )
              .get(),
          )
        )
          throw new Error("Commons project scope does not belong to the company")
        const content =
          input.source_type === "url"
            ? JSON.stringify({ url: validateURLTarget(input.url) })
            : "content" in input
              ? input.content
              : input.content_base64
        if ("media_type" in input && !mediaTypeAllowed(input.source_type, input.media_type))
          throw new Error(`Blocked MIME type for ${input.source_type}`)
        if ("content_base64" in input) {
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content_base64))
            throw new Error("Commons media payload is not valid base64")
          if (Buffer.from(input.content_base64, "base64").byteLength > MAX_MEDIA_BYTES)
            throw new Error("Commons media payload exceeds the size limit")
        }
        const now = Date.now()
        const source_id = Identifier.ascending("commonsSource")
        const artifact_id = Identifier.ascending("artifact")
        Database.transaction((db) => {
          const exact = db
            .select()
            .from(CompanyCommonsSourceTable)
            .where(
              and(
                eq(CompanyCommonsSourceTable.company_id, input.company_id),
                eq(CompanyCommonsSourceTable.content_hash, sha256(content)),
              ),
            )
            .all()
            .find((row) => scopeMatch(row, input))
          db.insert(CompanyArtifactTable)
            .values({
              id: artifact_id,
              project_id: input.privacy_scope === "project" ? input.project_id : null,
              company_id: input.privacy_scope === "project" ? null : input.company_id,
              scope_type: input.privacy_scope,
              private_owner_id: input.privacy_scope === "private" ? input.private_owner_id : null,
              work_item_id: null,
              kind: `commons_source_${input.source_type}`,
              title: input.title,
              path: null,
              content,
              evidence_json: JSON.stringify({
                commons_source_id: source_id,
                source_type: input.source_type,
                trust_class: "untrusted_source",
                instructions_allowed: false,
                media_type: "media_type" in input ? input.media_type : undefined,
              }),
              created_by_agent_id: null,
              created_at: now,
            })
            .run()
          db.insert(CompanyCommonsSourceTable)
            .values({
              id: source_id,
              artifact_id,
              company_id: input.company_id,
              project_id: input.privacy_scope === "project" ? input.project_id : null,
              private_owner_id: input.privacy_scope === "private" ? input.private_owner_id : null,
              source_type: input.source_type,
              title: input.title,
              author: input.author ?? null,
              origin: input.source_type === "url" ? validateURLTarget(input.url) : input.origin ?? null,
              published_at: input.published_at ?? null,
              language: input.language ?? null,
              tags_json: JSON.stringify([...new Set(input.tags)].sort()),
              privacy_scope: input.privacy_scope,
              ingestion_status: "queued",
              transcript_status: transcriptTypes.has(input.source_type) ? "queued" : "not_applicable",
              content_hash: sha256(content),
              normalized_content_hash: null,
              duplicate_of_source_id: exact?.id ?? null,
              deduplication_kind: exact ? "exact" : null,
              metadata_json: JSON.stringify(input.metadata),
              adapter_id: null,
              adapter_version: null,
              error_code: null,
              error_message: null,
              created_at: now,
              updated_at: now,
            })
            .run()
        })
        const source = sourceFromRow(
          Database.use((db) =>
            db.select().from(CompanyCommonsSourceTable).where(eq(CompanyCommonsSourceTable.id, source_id)).get(),
          )!,
        )
        yield* process(source).pipe(
          Effect.catchDefect((error) =>
            Effect.sync(() =>
              setFailure(
                source.id,
                error instanceof BlockedSourceError ? "blocked" : "failed",
                error instanceof BlockedSourceError ? "source_blocked" : "adapter_failed",
                error instanceof Error ? error.message : String(error),
              ),
            ),
          ),
        )
        return sourceFromRow(
          Database.use((db) =>
            db.select().from(CompanyCommonsSourceTable).where(eq(CompanyCommonsSourceTable.id, source.id)).get(),
          )!,
        )
      })

      const retry = Effect.fn("CompanyCommons.retry")(function* (
        id: string,
        rawAccess: CommonsAccessValue,
      ) {
        const detail = yield* get(id, rawAccess)
        if (!detail) throw new Error("Commons source not found")
        if (detail.source.ingestion_status === "ready") return detail.source
        Database.use((db) =>
          db
            .update(CompanyCommonsSourceTable)
            .set({
              ingestion_status: "queued",
              transcript_status: transcriptTypes.has(detail.source.source_type) ? "queued" : "not_applicable",
              error_code: null,
              error_message: null,
              updated_at: Date.now(),
            })
            .where(eq(CompanyCommonsSourceTable.id, id))
            .run(),
        )
        yield* process(detail.source).pipe(
          Effect.catchDefect((error) =>
            Effect.sync(() =>
              setFailure(
                id,
                error instanceof BlockedSourceError ? "blocked" : "failed",
                error instanceof BlockedSourceError ? "source_blocked" : "adapter_failed",
                error instanceof Error ? error.message : String(error),
              ),
            ),
          ),
        )
        return sourceFromRow(
          Database.use((db) =>
            db.select().from(CompanyCommonsSourceTable).where(eq(CompanyCommonsSourceTable.id, id)).get(),
          )!,
        )
      })

      const search = Effect.fn("CompanyCommons.search")(function* (
        rawQuery: string,
        rawAccess: CommonsAccessValue,
        rawLimit = 20,
      ) {
        const access = CommonsAccess.parse(rawAccess)
        const query = [...rawQuery.normalize("NFKC").matchAll(/[\p{L}\p{N}_-]+/gu)]
          .map((match) => `"${match[0]!.replaceAll('"', '""')}"`)
          .join(" ")
        if (!query) return []
        const limit = z.number().int().positive().max(100).parse(rawLimit)
        const projectClause = access.project_ids.length
          ? ` OR (source.privacy_scope = 'project' AND source.project_id IN (${access.project_ids.map(() => "?").join(",")}))`
          : ""
        const privateClause = access.private_owner_id
          ? " OR (source.privacy_scope = 'private' AND source.private_owner_id = ?)"
          : ""
        const rows = Database.Client().$client
          .query(`
            SELECT chunk.id AS chunk_id, source.id AS source_id,
                   snippet(company_commons_chunk_fts, 0, '<<', '>>', '...', 32) AS excerpt,
                   bm25(company_commons_chunk_fts) AS score
            FROM company_commons_chunk_fts
            JOIN company_commons_chunk AS chunk ON chunk.rowid = company_commons_chunk_fts.rowid
            JOIN company_commons_source AS source ON source.id = chunk.source_id
            WHERE company_commons_chunk_fts MATCH ?
              AND source.company_id = ?
              AND source.ingestion_status = 'ready'
              AND (
                source.privacy_scope = 'company'
                ${projectClause}
                ${privateClause}
              )
            ORDER BY score
            LIMIT ?
          `)
          .all(
            query,
            access.company_id,
            ...access.project_ids,
            ...(access.private_owner_id ? [access.private_owner_id] : []),
            limit,
          ) as Array<{ chunk_id: string; source_id: string; excerpt: string; score: number }>
        const hits = CommonsSearchHit.array().parse(
          rows.map((row) => ({
            source: sourceFromRow(
              Database.use((db) =>
                db
                  .select()
                  .from(CompanyCommonsSourceTable)
                  .where(eq(CompanyCommonsSourceTable.id, row.source_id))
                  .get(),
              )!,
            ),
            chunk: chunkFromRow(
              Database.use((db) =>
                db
                  .select()
                  .from(CompanyCommonsChunkTable)
                  .where(eq(CompanyCommonsChunkTable.id, row.chunk_id))
                  .get(),
              )!,
            ),
            excerpt: row.excerpt,
            score: -row.score,
            retrieval: "sqlite_fts",
            embedding_status: options.embedding ? "available" : "unavailable",
            instructions_allowed: false,
          })),
        )
        if (!options.embedding || hits.length === 0) return hits
        const vectors = yield* Effect.promise(() =>
          options.embedding!.embed([rawQuery, ...hits.map((hit) => hit.chunk.body)]),
        )
        const queryVector = vectors[0]
        if (!queryVector || vectors.length !== hits.length + 1) return hits
        const cosine = (left: number[], right: number[]) => {
          if (left.length === 0 || left.length !== right.length) return 0
          const dot = left.reduce((sum, value, index) => sum + value * right[index]!, 0)
          const magnitude =
            Math.sqrt(left.reduce((sum, value) => sum + value * value, 0)) *
            Math.sqrt(right.reduce((sum, value) => sum + value * value, 0))
          return magnitude ? dot / magnitude : 0
        }
        return hits
          .map((hit, index) => ({
            ...hit,
            score: hit.score + cosine(queryVector, vectors[index + 1]!) * 0.25,
          }))
          .sort((left, right) => right.score - left.score)
      })

      const recover = Effect.fn("CompanyCommons.recover")(function* () {
        return {
          recovered_source_ids: Database.transaction((db) =>
            db
              .select()
              .from(CompanyCommonsSourceTable)
              .where(eq(CompanyCommonsSourceTable.ingestion_status, "processing"))
              .all()
              .map((row) => {
                db.update(CompanyCommonsSourceTable)
                  .set({
                    ingestion_status: "queued",
                    transcript_status: transcriptTypes.has(row.source_type as CommonsSourceType)
                      ? "queued"
                      : "not_applicable",
                    error_code: "interrupted",
                    error_message: "Processing was interrupted and can be retried",
                    updated_at: Date.now(),
                  })
                  .where(eq(CompanyCommonsSourceTable.id, row.id))
                  .run()
                return row.id
              }),
          ),
        }
      })

      return Service.of({ capabilities, importSource, retry, get, list, search, recover })
    }),
  )
}

export const defaultLayer = makeLayer()
