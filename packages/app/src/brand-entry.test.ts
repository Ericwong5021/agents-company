import { describe, expect, test } from "bun:test"

const [html, headers, manifest] = await Promise.all([
  Bun.file(new URL("../index.html", import.meta.url)).text(),
  Bun.file(new URL("../public/_headers", import.meta.url)).text(),
  Bun.file(new URL("../public/site.webmanifest", import.meta.url)).json(),
])

describe("Agent Company browser entry", () => {
  test("uses only local Agent Company identity assets", () => {
    expect(html).toContain("<title>Agent Company</title>")
    expect(html).toContain("/agent-company-mark.svg")
    expect(html).toContain("/agent-company-icon-192.png")
    expect(html).toContain("/agent-company-theme-preload.js")
    expect(html).not.toContain("OpenCode")
    expect(html).not.toContain("social-share")
  })

  test("keeps the strict local CSP on hosted assets", () => {
    expect(headers).toContain("default-src 'self'")
    expect(headers).toContain("script-src 'self'")
    expect(headers).toContain("object-src 'none'")
    expect(headers).toContain("frame-ancestors 'none'")
  })

  test("declares only generated browser icons", () => {
    expect(manifest.name).toBe("Agent Company")
    expect(manifest.icons).toEqual([
      { src: "/agent-company-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/agent-company-icon-512.png", sizes: "512x512", type: "image/png" },
    ])
  })
})
