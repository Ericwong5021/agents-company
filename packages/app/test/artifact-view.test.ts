import { describe, expect, test } from "bun:test"
import {
  dataUrl,
  downloadFileName,
  formatByteLength,
  isOversizedForInline,
  parseCsvPreview,
  prettyJson,
  resolveRenderMode,
} from "../modules/agent-company/runtime/shared/artifact-view"

describe("resolveRenderMode", () => {
  test("markdown by media type and by extension", () => {
    expect(resolveRenderMode({ mediaType: "text/markdown", presentation: "text", title: "report", content: "x" })).toBe("markdown")
    expect(resolveRenderMode({ mediaType: "text/plain", presentation: "text", title: "notes.md", content: "x" })).toBe("markdown")
  })

  test("json and csv detection", () => {
    expect(resolveRenderMode({ mediaType: "application/json", presentation: "text", title: "d", content: "{}" })).toBe("json")
    expect(resolveRenderMode({ mediaType: "text/csv", presentation: "text", title: "d", content: "a,b" })).toBe("csv")
  })

  test("code via extension, image, pdf", () => {
    expect(resolveRenderMode({ mediaType: "text/plain", presentation: "text", title: "main.ts", content: "x" })).toBe("code")
    expect(resolveRenderMode({ mediaType: "image/png", presentation: "media", title: "shot", content: "x" })).toBe("image")
    expect(resolveRenderMode({ mediaType: "application/pdf", presentation: "download", title: "spec", content: "x" })).toBe("pdf")
  })

  test("falls back to text then download", () => {
    expect(resolveRenderMode({ mediaType: "text/plain", presentation: "text", title: "readme", content: "x" })).toBe("text")
    expect(resolveRenderMode({ mediaType: "application/zip", presentation: "download", title: "bundle", content: "x" })).toBe("download")
  })
})

describe("formatByteLength", () => {
  test("scales units and guards non-positive", () => {
    expect(formatByteLength(0)).toBe("0 B")
    expect(formatByteLength(512)).toBe("512 B")
    expect(formatByteLength(2048)).toBe("2.0 KB")
  })
})

test("isOversizedForInline flags large payloads", () => {
  expect(isOversizedForInline({ byteLength: 1024 })).toBe(false)
  expect(isOversizedForInline({ byteLength: 2 * 1024 * 1024 })).toBe(true)
})

describe("prettyJson", () => {
  test("pretty-prints valid json and returns raw on failure", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson("not json")).toBe("not json")
  })
})

describe("parseCsvPreview", () => {
  test("splits headers and rows with truncation flag", () => {
    const preview = parseCsvPreview("a,b\n1,2\n3,4", 1)
    expect(preview.headers).toEqual(["a", "b"])
    expect(preview.rows).toEqual([["1", "2"]])
    expect(preview.truncated).toBe(true)
  })
})

describe("downloadFileName", () => {
  test("keeps existing extension, otherwise appends by media type", () => {
    expect(downloadFileName({ mediaType: "text/markdown", presentation: "text", title: "report.md", content: "x" })).toBe("report.md")
    expect(downloadFileName({ mediaType: "text/markdown", presentation: "text", title: "report", content: "x" })).toBe("report.md")
    expect(downloadFileName({ mediaType: "application/json", presentation: "text", title: "data", content: "x" })).toBe("data.json")
  })
})

describe("dataUrl", () => {
  test("builds base64 and utf8 urls", () => {
    expect(dataUrl({ encoding: "base64", mediaType: "image/png", content: "AAAA" })).toBe("data:image/png;base64,AAAA")
    expect(dataUrl({ encoding: "utf8", mediaType: "text/plain", content: "a b" })).toBe("data:text/plain;charset=utf-8,a%20b")
  })
})
