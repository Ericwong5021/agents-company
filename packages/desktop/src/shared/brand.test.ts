import { createHash } from "node:crypto"
import path from "node:path"
import { expect, test } from "bun:test"
import { PRODUCT_BRAND } from "./brand"

const digest = async (file: string) =>
  createHash("sha256").update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex")
const prefix = async (file: string, length: number) => Array.from(new Uint8Array(await Bun.file(file).slice(0, length).arrayBuffer()))

test("has one Agent Company identity and non-upstream release assets", async () => {
  expect(PRODUCT_BRAND).toEqual({
    names: { dev: "Agent Company Dev", beta: "Agent Company Beta", prod: "Agent Company" },
    app_ids: {
      dev: "ai.agentcompany.desktop.dev",
      beta: "ai.agentcompany.desktop.beta",
      prod: "ai.agentcompany.desktop",
    },
    settings_store: "agent-company.settings",
    deep_link_protocol: "agentcompany",
    renderer_scheme: "ac",
  })

  const icons = path.resolve(import.meta.dir, "../../icons/agent-company")
  expect(await prefix(path.join(icons, "icon.icns"), 4)).toEqual([105, 99, 110, 115])
  expect(await prefix(path.join(icons, "icon.ico"), 4)).toEqual([0, 0, 1, 0])
  expect(await prefix(path.join(icons, "icon.png"), 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(await digest(path.join(icons, "source.svg"))).toBe(
    await digest(path.resolve(import.meta.dir, "../../../app/public/agent-company-mark.svg")),
  )
  expect(await digest(path.join(icons, "icon.icns"))).not.toBe(
    await digest(path.resolve(import.meta.dir, "../../icons/prod/icon.icns")),
  )
})
