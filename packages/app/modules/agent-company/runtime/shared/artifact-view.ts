import type { ExperienceArtifactView } from "@agents-company/shared/experience"

// DELIV-03 — Artifact 消费的展示层纯逻辑：
// 依据后端已下发的 mediaType / presentation / title / content 决定安全的预览方式，
// 不虚构后端未提供的版本历史或生成来源（那些字段当前不在 ExperienceArtifactView 契约中）。

export type ArtifactRenderMode =
  | "markdown"
  | "code"
  | "json"
  | "csv"
  | "image"
  | "pdf"
  | "text"
  | "download"

type ArtifactViewInput = Pick<ExperienceArtifactView, "mediaType" | "presentation" | "title" | "content">

const codeMediaHints = ["javascript", "typescript", "json", "xml", "yaml", "x-sh", "x-python", "x-c", "x-go", "sql"]
const codeExtensions = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "c", "h", "cpp", "cc",
  "sh", "bash", "zsh", "yml", "yaml", "toml", "xml", "html", "css", "scss", "sql", "vue", "svelte",
])

function extensionOf(title: string) {
  const dot = title.lastIndexOf(".")
  return dot >= 0 ? title.slice(dot + 1).toLowerCase() : ""
}

// 依据 mediaType 与文件名后缀判定预览模式；presentation 为最终兜底（media→图片、download→下载）。
export function resolveRenderMode(view: ArtifactViewInput): ArtifactRenderMode {
  const media = view.mediaType.toLowerCase()
  const ext = extensionOf(view.title)
  if (view.presentation === "media" && media.startsWith("image/")) return "image"
  if (media === "application/pdf" || ext === "pdf") return "pdf"
  if (view.presentation === "download") return "download"
  if (media.includes("markdown") || ext === "md" || ext === "markdown") return "markdown"
  if (media.includes("json") || ext === "json") return "json"
  if (media.includes("csv") || ext === "csv") return "csv"
  if (codeMediaHints.some((hint) => media.includes(hint)) || codeExtensions.has(ext)) return "code"
  if (media.startsWith("text/")) return "text"
  return "download"
}

const sizeUnits = ["B", "KB", "MB", "GB"]

// 人类可读的字节大小（保留一位小数，超过阈值不会阻塞页面而是引导下载/外部打开）。
export function formatByteLength(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizeUnits.length - 1)
  const value = bytes / 1024 ** exponent
  return `${exponent === 0 ? value : value.toFixed(1)} ${sizeUnits[exponent]}`
}

// 大文件阈值：文本类超过该字节数时提示改用下载，避免一次性渲染巨量内容卡死页面。
export const inlineTextByteLimit = 512 * 1024

export function isOversizedForInline(view: Pick<ExperienceArtifactView, "byteLength">) {
  return view.byteLength > inlineTextByteLimit
}

// JSON 安全美化：解析失败时原样返回，绝不隐藏“无法解析”的真实状态。
export function prettyJson(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}

export type CsvPreview = { headers: string[]; rows: string[][]; truncated: boolean }

// CSV 预览：按行/逗号切分并限制行数，超出上限标记 truncated，提示用户下载查看完整内容。
export function parseCsvPreview(content: string, maxRows = 50): CsvPreview {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0)
  const cells = lines.map((line) => line.split(","))
  const headers = cells[0] ?? []
  const body = cells.slice(1)
  return { headers, rows: body.slice(0, maxRows), truncated: body.length > maxRows }
}

// 下载文件名：优先用标题；标题缺后缀时按 mediaType 补一个安全后缀。
export function downloadFileName(view: ArtifactViewInput) {
  if (extensionOf(view.title)) return view.title
  const media = view.mediaType.toLowerCase()
  if (media.includes("markdown")) return `${view.title}.md`
  if (media.includes("json")) return `${view.title}.json`
  if (media.includes("csv")) return `${view.title}.csv`
  if (media === "application/pdf") return `${view.title}.pdf`
  if (media.startsWith("text/")) return `${view.title}.txt`
  return view.title
}

// 构造只读 data URL 供下载/图片预览；不发起额外请求、不触碰交付状态。
export function dataUrl(view: Pick<ExperienceArtifactView, "encoding" | "mediaType" | "content">) {
  if (view.encoding === "base64") return `data:${view.mediaType};base64,${view.content}`
  return `data:${view.mediaType};charset=utf-8,${encodeURIComponent(view.content)}`
}
