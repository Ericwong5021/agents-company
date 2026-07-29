import { lookup } from "node:dns/promises"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { isIP } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import TurndownService from "turndown"
import { spawn as spawnProcess } from "../util/process"
import { which } from "../util/which"
import {
  BlockedSourceError,
  type AdapterOutput,
  type CommonsAdapter,
} from "./company-commons"
import type { CommonsSourceType } from "./schema"

type UnavailableCapability = {
  status: "blocked" | "unsupported"
  reason_code: string
  reason: string
  requirements: string[]
}

const MAX_EXTRACTED_TEXT_BYTES = 10_000_000
const MAX_PROCESS_STDOUT_BYTES = 12_000_000
const MAX_PROCESS_STDERR_BYTES = 128_000

const PDF_SWIFT = `
import Foundation
import PDFKit
guard CommandLine.arguments.count == 2 else { exit(64) }
guard let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else { exit(65) }
let pages = (0..<document.pageCount).map { index -> [String: Any] in
  ["page": index + 1, "text": document.page(at: index)?.string ?? ""]
}
let data = try JSONSerialization.data(withJSONObject: pages)
FileHandle.standardOutput.write(data)
`

const OCR_SWIFT = `
import AppKit
import Foundation
import Vision
guard CommandLine.arguments.count == 2 else { exit(64) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
let lines = (request.results ?? []).compactMap { observation -> [String: Any]? in
  guard let candidate = observation.topCandidates(1).first else { return nil }
  return [
    "text": candidate.string,
    "confidence": candidate.confidence,
    "x": observation.boundingBox.origin.x,
    "y": observation.boundingBox.origin.y,
    "width": observation.boundingBox.size.width,
    "height": observation.boundingBox.size.height
  ]
}.sorted {
  let leftY = $0["y"] as! Double
  let rightY = $1["y"] as! Double
  if abs(leftY - rightY) > 0.02 { return leftY > rightY }
  return ($0["x"] as! Double) < ($1["x"] as! Double)
}
let data = try JSONSerialization.data(withJSONObject: lines)
FileHandle.standardOutput.write(data)
`

const limitedOutput = async (
  stream: Readable,
  max_bytes: number,
  label: string,
) => {
  const chunks: Uint8Array[] = []
  let byte_length = 0
  for await (const item of stream) {
    const chunk = typeof item === "string" ? Buffer.from(item) : new Uint8Array(item)
    byte_length += chunk.byteLength
    if (byte_length > max_bytes)
      throw new BlockedSourceError(`${label} exceeds the local output limit`)
    chunks.push(chunk)
  }
  const output = new Uint8Array(byte_length)
  let offset = 0
  chunks.forEach((chunk) => {
    output.set(chunk, offset)
    offset += chunk.byteLength
  })
  return output
}

const command = async (
  args: string[],
  timeout_ms: number,
  max_stdout_bytes = MAX_PROCESS_STDOUT_BYTES,
) => {
  const child = spawnProcess(args, { stdout: "pipe", stderr: "pipe" })
  if (!child.stdout || !child.stderr) throw new Error("Adapter process output is unavailable")
  const timeout = setTimeout(() => child.kill(), timeout_ms)
  const result = await Promise.all([
    child.exited,
    limitedOutput(child.stdout, max_stdout_bytes, "Adapter stdout"),
    limitedOutput(child.stderr, MAX_PROCESS_STDERR_BYTES, "Adapter stderr"),
  ])
    .catch((error) => {
      child.kill()
      throw error
    })
    .finally(() => clearTimeout(timeout))
  return {
    exit_code: result[0],
    stdout: result[1],
    stderr: new TextDecoder().decode(result[2]).trim().slice(0, 2_000),
  }
}

const mediaBytes = (content: string) => new Uint8Array(Buffer.from(content, "base64"))

const withMediaFile = async <T>(
  bytes: Uint8Array,
  extension: string,
  use: (input: string, directory: string) => Promise<T>,
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-company-commons-"))
  const input = path.join(directory, `source.${extension}`)
  await writeFile(input, bytes)
  return use(input, directory).finally(() => rm(directory, { recursive: true, force: true }))
}

const assertPDF = (bytes: Uint8Array) => {
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
    throw new BlockedSourceError("Commons PDF payload does not match application/pdf")
}

const imageExtension = (bytes: Uint8Array) => {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg"
  if (/^GIF8[79]a$/.test(new TextDecoder().decode(bytes.slice(0, 6)))) return "gif"
  if (
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  )
    return "webp"
  throw new BlockedSourceError("Commons image payload does not match its declared MIME type")
}

const extracted = (
  items: Array<{ text: string; locator: Record<string, unknown> }>,
): AdapterOutput => {
  const normalized = items.map((item) => ({ ...item, text: item.text.trim() })).filter((item) => item.text)
  const text = normalized.map((item) => item.text).join("\n\n")
  if (Buffer.byteLength(text) > MAX_EXTRACTED_TEXT_BYTES)
    throw new BlockedSourceError("Extracted Commons text exceeds the local output limit")
  const spans: NonNullable<AdapterOutput["spans"]> = []
  let cursor = 0
  normalized.forEach((item) => {
    const start_offset = text.indexOf(item.text, cursor)
    const end_offset = start_offset + item.text.length
    spans.push({ start_offset, end_offset, locator: item.locator })
    cursor = end_offset
  })
  return { text, spans }
}

const pdfText = async (bytes: Uint8Array) => {
  const swift = which("swift")
  if (process.platform !== "darwin" || !swift)
    throw new BlockedSourceError("The local PDFKit adapter is unavailable")
  assertPDF(bytes)
  return withMediaFile(bytes, "pdf", async (input, directory) => {
    const script = path.join(directory, "extract.swift")
    await writeFile(script, PDF_SWIFT)
    const result = await command([swift, script, input], 30_000)
    if (result.exit_code !== 0)
      throw new Error(result.stderr || `PDFKit exited with ${result.exit_code}`)
    const pages = JSON.parse(new TextDecoder().decode(result.stdout)) as Array<{
      page: number
      text: string
    }>
    const output = extracted(
      pages.map((page) => ({
        text: page.text,
        locator: { kind: "pdf_page", page: page.page },
      })),
    )
    if (!output.text) throw new BlockedSourceError("PDF contains no extractable text")
    return output
  })
}

const imageText = async (bytes: Uint8Array) =>
  withMediaFile(bytes, imageExtension(bytes), async (input, directory) => {
    const swift = which("swift")
    if (process.platform !== "darwin" || !swift)
      throw new BlockedSourceError("The local Vision OCR adapter is unavailable")
    const script = path.join(directory, "ocr.swift")
    await writeFile(script, OCR_SWIFT)
    const result = await command([swift, script, input], 45_000)
    if (result.exit_code !== 0)
      throw new Error(result.stderr || `Vision OCR exited with ${result.exit_code}`)
    const lines = JSON.parse(new TextDecoder().decode(result.stdout)) as Array<{
      text: string
      confidence: number
      x: number
      y: number
      width: number
      height: number
    }>
    const output = extracted(
      lines.map((line) => ({
        text: line.text,
        locator: {
          kind: "image_region",
          confidence: line.confidence,
          bounding_box: {
            x: line.x,
            y: line.y,
            width: line.width,
            height: line.height,
          },
        },
      })),
    )
    if (!output.text) throw new BlockedSourceError("Image contains no recognized text")
    return output
  })

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const textValue = (value: unknown) => {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return
  const parts = value.flatMap((item) => {
    if (typeof item === "string") return [item]
    const itemRecord = record(item)
    return typeof itemRecord?.text === "string" ? [itemRecord.text] : []
  })
  return parts.length ? parts.join("\n") : undefined
}

const conversationMessages = (content: string) => {
  const parsed = (() => {
    try {
      return JSON.parse(content) as unknown
    } catch {
      throw new BlockedSourceError("Conversation export is not valid JSON")
    }
  })()
  const root = record(parsed)
  const direct = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root?.messages)
      ? root.messages
      : Array.isArray(root?.chat_messages)
        ? root.chat_messages
        : undefined
  if (direct)
    return direct.flatMap((value, index) => {
      const item = record(value)
      const role = item?.role ?? item?.sender ?? record(item?.author)?.role
      const body = textValue(item?.content) ?? textValue(item?.text) ?? textValue(item?.message)
      return typeof role === "string" && body?.trim()
        ? [{ role, content: body.trim(), index, timestamp: item?.created_at ?? item?.create_time }]
        : []
    })
  const mapping = record(root?.mapping)
  if (!mapping) throw new BlockedSourceError("Conversation export has no supported message collection")
  return Object.entries(mapping)
    .flatMap(([node_id, value], index) => {
      const message = record(record(value)?.message)
      const role = record(message?.author)?.role
      const body = textValue(record(message?.content)?.parts) ?? textValue(message?.content)
      return typeof role === "string" && body?.trim()
        ? [{
            role,
            content: body.trim(),
            index,
            node_id,
            timestamp: message?.create_time,
          }]
        : []
    })
    .sort((left, right) =>
      typeof left.timestamp === "number" && typeof right.timestamp === "number"
        ? left.timestamp - right.timestamp
        : left.index - right.index,
    )
}

const conversationAdapter: CommonsAdapter = {
  id: "local.conversation-export",
  version: "1",
  source_types: ["conversation_export"],
  process: async (input) => {
    const messages = conversationMessages(input.artifact_content)
    if (!messages.length)
      throw new BlockedSourceError("Conversation export contains no supported messages")
    return extracted(
      messages.map((message, index) => ({
        text: `${message.role}\n${message.content}`,
        locator: {
          kind: "conversation_message",
          message_index: index,
          role: message.role,
          node_id: "node_id" in message ? message.node_id : undefined,
          timestamp: message.timestamp,
        },
      })),
    )
  },
}

const blockedAddress = (address: string) => {
  if (!address.includes(":")) {
    const octets = address.split(".").map(Number)
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
      return true
    return (
      octets[0] === 0 ||
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 198 && octets[1]! >= 18 && octets[1]! <= 19) ||
      octets[0]! >= 224
    )
  }
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

const validURL = (value: string) => {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new BlockedSourceError("Commons URL must use HTTP or HTTPS without credentials")
  if (url.port && !(
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ))
    throw new BlockedSourceError("Commons URL must use the standard HTTP or HTTPS port")
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1")
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isIP(hostname) > 0 && blockedAddress(hostname)
  )
    throw new BlockedSourceError("Commons URL resolves to a blocked local or private target")
  url.hash = ""
  return url.toString()
}

const fetchURL = async (
  initial: string,
  policy: {
    timeout_ms: number
    max_bytes: number
    max_redirects: number
    allowed_mime_types: readonly string[]
  },
) => {
  const started = performance.now()
  const resolved_addresses = new Set<string>()
  let current = initial
  let redirects = 0
  return withMediaFile(new Uint8Array(), "body", async (_, directory) => {
    while (true) {
      const target = new URL(current)
      const addresses = await lookup(target.hostname, { all: true, verbatim: true })
      if (!addresses.length || addresses.some((entry) => blockedAddress(entry.address)))
        throw new BlockedSourceError("Commons URL resolved to a blocked local or private address")
      addresses.forEach((entry) => resolved_addresses.add(entry.address))
      const port = target.port || (target.protocol === "https:" ? "443" : "80")
      const address = addresses[0]!.address.includes(":")
        ? `[${addresses[0]!.address}]`
        : addresses[0]!.address
      const body = path.join(directory, "response.body")
      const headers = path.join(directory, "response.headers")
      const remaining = policy.timeout_ms - (performance.now() - started)
      if (remaining <= 0) throw new BlockedSourceError("Commons URL exceeded the timeout limit")
      const result = await command([
        which("curl")!,
        "--silent",
        "--show-error",
        "--noproxy",
        "*",
        "--proto",
        "=http,https",
        "--max-time",
        String(Math.max(1, Math.ceil(remaining / 1_000))),
        "--max-filesize",
        String(policy.max_bytes),
        "--max-redirs",
        "0",
        "--request",
        "GET",
        "--header",
        "Accept: text/plain, text/markdown, text/html, application/json, application/pdf",
        "--header",
        "User-Agent: AgentCompany-Local-Commons/1",
        "--header",
        "Accept-Encoding: identity",
        "--resolve",
        `${target.hostname}:${port}:${address}`,
        "--output",
        body,
        "--dump-header",
        headers,
        current,
      ], Math.ceil(remaining) + 1_000)
      if (result.exit_code === 63)
        throw new BlockedSourceError("Commons URL response exceeds the size limit")
      if (result.exit_code !== 0)
        throw new Error(result.stderr || `curl exited with ${result.exit_code}`)
      const blocks = (await readFile(headers, "utf8")).trim().split(/\r?\n\r?\n/).filter(Boolean)
      const lines = blocks.at(-1)!.split(/\r?\n/)
      const status = Number(lines[0]!.split(/\s+/)[1])
      const responseHeaders = new Map(
        lines.slice(1).flatMap((line) => {
          const separator = line.indexOf(":")
          return separator > 0
            ? [[line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()] as const]
            : []
        }),
      )
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (redirects >= policy.max_redirects)
          throw new BlockedSourceError("Commons URL exceeded the redirect limit")
        const location = responseHeaders.get("location")
        if (!location) throw new BlockedSourceError("Commons URL redirect has no Location")
        current = validURL(new URL(location, current).toString())
        redirects += 1
        continue
      }
      if (status < 200 || status >= 300) throw new Error(`Commons URL returned HTTP ${status}`)
      const contentEncoding = responseHeaders.get("content-encoding")?.toLowerCase()
      if (contentEncoding && contentEncoding !== "identity")
        throw new BlockedSourceError(`Commons URL returned blocked content encoding ${contentEncoding}`)
      const bytes = new Uint8Array(await readFile(body))
      if (bytes.byteLength > policy.max_bytes)
        throw new BlockedSourceError("Commons URL response exceeds the size limit")
      const mime_type = (responseHeaders.get("content-type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase()
      if (!policy.allowed_mime_types.includes(mime_type))
        throw new BlockedSourceError(`Commons URL returned blocked MIME type ${mime_type || "unknown"}`)
      return {
        bytes,
        final_url: current,
        mime_type,
        byte_length: bytes.byteLength,
        elapsed_ms: Math.round(performance.now() - started),
        redirects,
        resolved_addresses: [...resolved_addresses],
      }
    }
  })
}

const urlAdapter: CommonsAdapter = {
  id: "local.secure-url",
  version: "1",
  source_types: ["url"],
  process: async (input) => {
    const payload = JSON.parse(input.artifact_content) as { url?: unknown }
    if (typeof payload.url !== "string")
      throw new BlockedSourceError("Commons URL Artifact has no valid URL")
    const fetched = await fetchURL(validURL(payload.url), input.policy)
    const fetch = {
      final_url: fetched.final_url,
      mime_type: fetched.mime_type,
      byte_length: fetched.byte_length,
      elapsed_ms: fetched.elapsed_ms,
      redirects: fetched.redirects,
      resolved_addresses: fetched.resolved_addresses,
    }
    if (fetched.mime_type === "application/pdf") {
      const output = await pdfText(fetched.bytes)
      return {
        ...output,
        artifact_content: Buffer.from(fetched.bytes).toString("base64"),
        artifact_encoding: "base64" as const,
        fetch,
      }
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes)
    const text = fetched.mime_type === "text/html"
      ? new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(source)
      : source
    return {
      text,
      artifact_content: source,
      artifact_encoding: "utf8" as const,
      spans: [{
        start_offset: 0,
        end_offset: text.length,
        locator: { kind: "url_document", url: fetched.final_url, mime_type: fetched.mime_type },
      }],
      fetch,
    }
  },
}

const pdfAdapter: CommonsAdapter = {
  id: "local.macos-pdfkit",
  version: "1",
  source_types: ["pdf"],
  process: async (input) => pdfText(mediaBytes(input.artifact_content)),
}

const imageAdapter: CommonsAdapter = {
  id: "local.macos-vision-ocr",
  version: "1",
  source_types: ["image"],
  process: async (input) => imageText(mediaBytes(input.artifact_content)),
}

const transcriber = () => {
  const configured = process.env.AGENTCOMPANY_LOCAL_TRANSCRIBER?.trim()
  if (!configured) return
  const executable = which(configured) ??
    (path.isAbsolute(configured) && existsSync(configured) ? configured : undefined)
  if (!executable) return
  const rawArgs = process.env.AGENTCOMPANY_LOCAL_TRANSCRIBER_ARGS_JSON
  const args = (() => {
    if (!rawArgs) return ["{input}"]
    try {
      return JSON.parse(rawArgs) as unknown
    } catch {
      return
    }
  })()
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) return
  return { executable, args: args as string[] }
}

const probeMedia = async (input: string, expected: "audio" | "video") => {
  const ffprobe = which("ffprobe")
  if (!ffprobe) throw new BlockedSourceError("ffprobe is required to validate local media")
  const result = await command([
    ffprobe,
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name",
    "-of",
    "json",
    input,
  ], 15_000)
  if (result.exit_code !== 0)
    throw new BlockedSourceError(result.stderr || "Media payload could not be validated")
  const data = JSON.parse(new TextDecoder().decode(result.stdout)) as {
    streams?: Array<{ codec_type?: string; codec_name?: string }>
  }
  if (!data.streams?.some((stream) => stream.codec_type === expected))
    throw new BlockedSourceError(`Commons media payload has no ${expected} stream`)
}

const transcribe = async (input: string, source_kind: "podcast" | "video") => {
  const configured = transcriber()
  if (!configured)
    throw new BlockedSourceError("A local transcription executable is not configured")
  const result = await command([
    configured.executable,
    ...configured.args.map((argument) => argument.replaceAll("{input}", input)),
  ], 10 * 60_000, MAX_PROCESS_STDOUT_BYTES)
  if (result.exit_code !== 0)
    throw new Error(result.stderr || `Local transcriber exited with ${result.exit_code}`)
  const text = new TextDecoder().decode(result.stdout).trim()
  if (!text) throw new Error("Local transcriber returned an empty transcript")
  const structured = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return
    }
  })()
  const output = record(structured)
  const segments = Array.isArray(output?.segments)
    ? output.segments.flatMap((value) => {
        const segment = record(value)
        return typeof segment?.text === "string" &&
          typeof segment.start === "number" &&
          typeof segment.end === "number"
          ? [{
              text: segment.text,
              locator: {
                kind: "media_time_range",
                source_kind,
                start_seconds: segment.start,
                end_seconds: segment.end,
              },
            }]
          : []
      })
    : []
  if (segments.length) return extracted(segments)
  const transcript = typeof output?.text === "string" ? output.text.trim() : text
  if (Buffer.byteLength(transcript) > MAX_EXTRACTED_TEXT_BYTES)
    throw new BlockedSourceError("Local transcript exceeds the Commons output limit")
  return {
    text: transcript,
    spans: [{
      start_offset: 0,
      end_offset: transcript.length,
      locator: { kind: "media_transcript", source_kind, source: "local_transcriber" },
    }],
  }
}

const podcastAdapter: CommonsAdapter = {
  id: "local.configured-transcriber",
  version: "1",
  source_types: ["podcast"],
  process: async (input) =>
    withMediaFile(mediaBytes(input.artifact_content), "audio", async (file) => {
      await probeMedia(file, "audio")
      return transcribe(file, "podcast")
    }),
}

const videoAdapter: CommonsAdapter = {
  id: "local.ffmpeg-configured-transcriber",
  version: "1",
  source_types: ["video"],
  process: async (input) =>
    withMediaFile(mediaBytes(input.artifact_content), "video", async (file, directory) => {
      await probeMedia(file, "video")
      const ffmpeg = which("ffmpeg")
      if (!ffmpeg) throw new BlockedSourceError("ffmpeg is required to extract a video audio track")
      const audio = path.join(directory, "audio.wav")
      const result = await command([
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-i",
        file,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        audio,
      ], 2 * 60_000)
      if (result.exit_code !== 0)
        throw new Error(result.stderr || `ffmpeg exited with ${result.exit_code}`)
      return transcribe(audio, "video")
    }),
}

const blocked = (
  reason_code: string,
  reason: string,
  requirements: string[],
): UnavailableCapability => ({ status: "blocked", reason_code, reason, requirements })

export const defaultAdapterRegistry = () => {
  const adapters = [conversationAdapter]
  const unavailable: Partial<Record<CommonsSourceType, UnavailableCapability>> = {}
  if (which("curl")) adapters.push(urlAdapter)
  else unavailable.url = blocked("curl_unavailable", "A local curl executable is required", ["curl"])
  if (
    process.platform === "darwin" &&
    which("swift") &&
    existsSync("/System/Library/Frameworks/PDFKit.framework")
  )
    adapters.push(pdfAdapter)
  else
    unavailable.pdf = {
      status: "unsupported",
      reason_code: "pdfkit_unsupported",
      reason: "The built-in PDF adapter requires macOS PDFKit",
      requirements: ["macOS", "PDFKit"],
    }
  if (
    process.platform === "darwin" &&
    which("swift") &&
    existsSync("/System/Library/Frameworks/Vision.framework") &&
    existsSync("/System/Library/Frameworks/AppKit.framework")
  )
    adapters.push(imageAdapter)
  else
    unavailable.image = {
      status: "unsupported",
      reason_code: "vision_ocr_unsupported",
      reason: "The built-in OCR adapter requires macOS Vision",
      requirements: ["macOS", "Vision"],
    }
  const localTranscriber = transcriber()
  if (localTranscriber && which("ffprobe")) adapters.push(podcastAdapter)
  else
    unavailable.podcast = blocked(
      "local_transcriber_unavailable",
      "Podcast import requires an explicitly configured local transcriber and ffprobe",
      ["AGENTCOMPANY_LOCAL_TRANSCRIBER", "ffprobe"],
    )
  if (localTranscriber && which("ffprobe") && which("ffmpeg")) adapters.push(videoAdapter)
  else
    unavailable.video = blocked(
      "video_transcriber_unavailable",
      "Video import requires ffmpeg, ffprobe, and an explicitly configured local transcriber",
      ["ffmpeg", "ffprobe", "AGENTCOMPANY_LOCAL_TRANSCRIBER"],
    )
  return { adapters, unavailable }
}
