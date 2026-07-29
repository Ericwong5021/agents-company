import z from "zod"

export const CommonsSourceType = z.enum([
  "text",
  "markdown",
  "url",
  "conversation_export",
  "pdf",
  "image",
  "podcast",
  "video",
])
export type CommonsSourceType = z.infer<typeof CommonsSourceType>

export const CommonsPrivacyScope = z.enum(["company", "project", "private"])
export type CommonsPrivacyScope = z.infer<typeof CommonsPrivacyScope>

export const CommonsIngestionStatus = z.enum([
  "queued",
  "processing",
  "ready",
  "failed",
  "blocked",
  "unsupported",
])
export type CommonsIngestionStatus = z.infer<typeof CommonsIngestionStatus>

export const CommonsTranscriptStatus = z.enum([
  "not_applicable",
  "queued",
  "processing",
  "ready",
  "failed",
  "blocked",
  "unsupported",
])
export type CommonsTranscriptStatus = z.infer<typeof CommonsTranscriptStatus>

export const CommonsScope = z.discriminatedUnion("privacy_scope", [
  z.object({ privacy_scope: z.literal("company") }),
  z.object({ privacy_scope: z.literal("project"), project_id: z.string().trim().min(1) }),
  z.object({ privacy_scope: z.literal("private"), private_owner_id: z.string().trim().min(1) }),
])
export type CommonsScope = z.infer<typeof CommonsScope>

const CommonsMetadata = z.object({
  company_id: z.string().trim().min(1),
  title: z.string().trim().min(1).max(500),
  author: z.string().trim().min(1).max(500).optional(),
  origin: z.string().trim().min(1).max(4_000).optional(),
  published_at: z.number().int().nonnegative().optional(),
  language: z.string().trim().min(1).max(64).optional(),
  tags: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

const TextSubmission = CommonsMetadata.extend({
  source_type: z.enum(["text", "markdown", "conversation_export"]),
  content: z.string().min(1).max(10_000_000),
})

const URLSubmission = CommonsMetadata.extend({
  source_type: z.literal("url"),
  url: z.string().trim().min(1).max(4_000),
})

const MediaSubmission = CommonsMetadata.extend({
  source_type: z.enum(["pdf", "image", "podcast", "video"]),
  content_base64: z.string().min(1).max(28_000_000),
  media_type: z.string().trim().min(1).max(255),
})

export const CommonsSourceSubmission = z.intersection(
  CommonsScope,
  z.discriminatedUnion("source_type", [TextSubmission, URLSubmission, MediaSubmission]),
)
export type CommonsSourceSubmission = z.infer<typeof CommonsSourceSubmission>

export const CommonsSource = z.object({
  id: z.string(),
  artifact_id: z.string(),
  company_id: z.string(),
  project_id: z.string().optional(),
  private_owner_id: z.string().optional(),
  source_type: CommonsSourceType,
  title: z.string(),
  author: z.string().optional(),
  origin: z.string().optional(),
  published_at: z.number().optional(),
  language: z.string().optional(),
  tags: z.array(z.string()),
  privacy_scope: CommonsPrivacyScope,
  ingestion_status: CommonsIngestionStatus,
  transcript_status: CommonsTranscriptStatus,
  content_hash: z.string().optional(),
  normalized_content_hash: z.string().optional(),
  duplicate_of_source_id: z.string().optional(),
  deduplication_kind: z.enum(["exact", "normalized"]).optional(),
  metadata: z.record(z.string(), z.unknown()),
  adapter_id: z.string().optional(),
  adapter_version: z.string().optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  created_at: z.number(),
  updated_at: z.number(),
})
export type CommonsSource = z.infer<typeof CommonsSource>

export const CommonsChunk = z.object({
  id: z.string(),
  source_id: z.string(),
  ordinal: z.number().int().nonnegative(),
  body: z.string(),
  content_hash: z.string(),
  start_offset: z.number().int().nonnegative(),
  end_offset: z.number().int().nonnegative(),
  source_span: z.record(z.string(), z.unknown()),
  trust_class: z.literal("untrusted_source"),
  created_at: z.number(),
})
export type CommonsChunk = z.infer<typeof CommonsChunk>

export const CommonsSourceDetail = z.object({
  source: CommonsSource,
  artifact: z.object({
    id: z.string(),
    scope_type: CommonsPrivacyScope,
    project_id: z.string().optional(),
    company_id: z.string().optional(),
    private_owner_id: z.string().optional(),
    kind: z.string(),
    title: z.string(),
    content: z.string().optional(),
    evidence: z.record(z.string(), z.unknown()),
    created_at: z.number(),
  }),
  chunks: z.array(CommonsChunk),
})
export type CommonsSourceDetail = z.infer<typeof CommonsSourceDetail>

export const CommonsAccess = z.object({
  company_id: z.string().trim().min(1),
  project_ids: z.array(z.string().trim().min(1)).max(500).default([]),
  private_owner_id: z.string().trim().min(1).optional(),
})
export type CommonsAccess = z.infer<typeof CommonsAccess>

export const CommonsSearchHit = z.object({
  source: CommonsSource,
  chunk: CommonsChunk,
  excerpt: z.string(),
  score: z.number(),
  retrieval: z.literal("sqlite_fts"),
  embedding_status: z.enum(["unavailable", "available"]),
  instructions_allowed: z.literal(false),
})
export type CommonsSearchHit = z.infer<typeof CommonsSearchHit>

export const CommonsCapability = z.object({
  source_type: CommonsSourceType,
  status: z.enum(["available", "adapter_required"]),
  adapter_id: z.string().optional(),
  supports_transcript: z.boolean(),
})
export type CommonsCapability = z.infer<typeof CommonsCapability>
