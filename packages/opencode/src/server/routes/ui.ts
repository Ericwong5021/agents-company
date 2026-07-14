import { Flag } from "@/flag/flag"
import { Hono } from "hono"
import { getMimeType } from "hono/utils/mime"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const embeddedUIPromise = Flag.AGENTCOMPANY_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("agent-company-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* ws://[::1]:*; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"

export const UIRoutes = (): Hono =>
  new Hono().all("/*", async (c, next) => {
    const embeddedWebUI = await embeddedUIPromise
    if (!embeddedWebUI && c.req.path === "/") return c.text("Web UI is not embedded in this build", 404)
    if (!embeddedWebUI) return next()

    const file = c.req.path.replace(/^\//, "")
    const match =
      embeddedWebUI[file] ?? (file === "" || c.req.header("accept")?.includes("text/html") ? embeddedWebUI["index.html"] : undefined)
    if (!match) return next()

    const asset = path.isAbsolute(match) ? match : path.resolve(path.dirname(fileURLToPath(import.meta.url)), match)
    const exists = await fs.access(asset).then(
      () => true,
      () => false,
    )
    if (!exists) return c.json({ error: "Not Found" }, 404)

    const mime = getMimeType(asset) ?? "text/plain"
    c.header("Content-Type", mime)
    c.header("Content-Security-Policy", DEFAULT_CSP)
    return c.body(new Uint8Array(await fs.readFile(asset)))
  })
