import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs"
import { and, eq } from "drizzle-orm"
import {
  ExperienceArtifactRef,
  ExperienceArtifactView,
  type ExperienceArtifactRef as ExperienceArtifactRefValue,
} from "@agents-company/shared/experience"
import { AppFileSystem } from "@agents-company/shared/filesystem"
import { Database } from "@/storage"
import { CompanyArtifactTable, CompanyProjectTable } from "./company-project.sql"

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

const textMediaTypes = new Set(["application/json", "application/javascript", "application/xml", "application/x-yaml"])
const browserMediaTypes = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"

function attempt<T>(run: () => T) {
  try {
    return run()
  } catch {
    return undefined
  }
}

function withProjectFile<T>(
  outputDirectory: string,
  artifactPath: string,
  use: (file: { descriptor: number; path: string; byteLength: number }) => T,
) {
  return attempt(() => {
    const rootDescriptor = openSync(
      outputDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      const root = realpathSync(`${descriptorDirectory}/${rootDescriptor}`)
      const target = realpathSync(artifactPath)
      if (!AppFileSystem.contains(root, target)) return undefined
      const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const actualPath = realpathSync(`${descriptorDirectory}/${descriptor}`)
        const metadata = fstatSync(descriptor)
        if (!AppFileSystem.contains(root, actualPath) || !metadata.isFile()) return undefined
        if (metadata.size < 1 || metadata.size > MAX_ARTIFACT_BYTES) return undefined
        return use({ descriptor, path: actualPath, byteLength: metadata.size })
      } finally {
        closeSync(descriptor)
      }
    } finally {
      closeSync(rootDescriptor)
    }
  })
}

function readFile(descriptor: number, byteLength: number) {
  const content = Buffer.allocUnsafe(byteLength)
  let offset = 0
  while (offset < byteLength) {
    const count = readSync(descriptor, content, offset, byteLength - offset, offset)
    if (count < 1) return undefined
    offset += count
  }
  if (readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, byteLength) > 0) return undefined
  if (fstatSync(descriptor).size !== byteLength) return undefined
  return content
}

export function href(projectID: string, artifactID: string) {
  return `/experience/projects/${encodeURIComponent(projectID)}/artifacts/${encodeURIComponent(artifactID)}`
}

export function reference(input: { id: string; projectId: string; kind: string; title: string }) {
  return ExperienceArtifactRef.parse({
    ...input,
    href: href(input.projectId, input.id),
  })
}

export function openable(input: { outputDirectory: string; path: string | null; content: string | null }) {
  if (input.content !== null) {
    const byteLength = Buffer.byteLength(input.content)
    if (byteLength > 0 && byteLength <= MAX_ARTIFACT_BYTES) return true
  }
  return Boolean(input.path && withProjectFile(input.outputDirectory, input.path, () => true))
}

function inlineView(artifact: ExperienceArtifactRefValue & { content: string; createdAt: number }) {
  return ExperienceArtifactView.parse({
    ...artifact,
    source: "inline",
    mediaType: "text/plain",
    encoding: "utf8",
    presentation: "text",
    content: artifact.content,
    byteLength: Buffer.byteLength(artifact.content),
    createdAt: new Date(artifact.createdAt).toISOString(),
  })
}

function fileView(
  artifact: ExperienceArtifactRefValue & {
    outputDirectory: string
    path: string
    createdAt: number
  },
) {
  return withProjectFile(artifact.outputDirectory, artifact.path, (file) => {
    const content = readFile(file.descriptor, file.byteLength)
    if (!content) return undefined
    const mediaType = AppFileSystem.mimeType(file.path)
    const text =
      mediaType.startsWith("text/") || textMediaTypes.has(mediaType)
        ? attempt(() => new TextDecoder("utf-8", { fatal: true }).decode(content))
        : undefined
    return ExperienceArtifactView.parse({
      id: artifact.id,
      projectId: artifact.projectId,
      kind: artifact.kind,
      title: artifact.title,
      href: artifact.href,
      source: "project_file",
      mediaType,
      encoding: text === undefined ? "base64" : "utf8",
      presentation: text === undefined ? (browserMediaTypes.has(mediaType) ? "media" : "download") : "text",
      content: text ?? content.toString("base64"),
      byteLength: content.byteLength,
      createdAt: new Date(artifact.createdAt).toISOString(),
    })
  })
}

export function read(projectID: string, artifactID: string) {
  const project = Database.use((db) =>
    db.select().from(CompanyProjectTable).where(eq(CompanyProjectTable.id, projectID)).get(),
  )
  if (!project) return { status: "not_found" as const }
  const row = Database.use((db) =>
    db
      .select()
      .from(CompanyArtifactTable)
      .where(and(eq(CompanyArtifactTable.id, artifactID), eq(CompanyArtifactTable.project_id, projectID)))
      .get(),
  )
  if (!row) return { status: "not_found" as const }
  const artifact = reference({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
  })
  if (
    row.content !== null &&
    Buffer.byteLength(row.content) > 0 &&
    Buffer.byteLength(row.content) <= MAX_ARTIFACT_BYTES
  )
    return {
      status: "available" as const,
      artifact: inlineView({ ...artifact, content: row.content, createdAt: row.created_at }),
    }
  if (row.path) {
    const view = fileView({
      ...artifact,
      outputDirectory: project.output_dir,
      path: row.path,
      createdAt: row.created_at,
    })
    if (view) return { status: "available" as const, artifact: view }
  }
  return { status: "unavailable" as const }
}
