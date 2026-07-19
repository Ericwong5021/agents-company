import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/agent-company-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("ignores prior product theme keys before mount", () => {
    localStorage.setItem("control-plane-theme-id", "legacy-default")
    localStorage.setItem("control-plane-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("control-plane-theme-css-dark", "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe("agent-company")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("agent-company.theme-id")).toBeNull()
    expect(document.getElementById("agent-company-theme-preload")).toBeNull()
  })

  test("keeps cached css for non-default themes", () => {
    localStorage.setItem("agent-company.theme-id", "nightowl")
    localStorage.setItem("agent-company.theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.getElementById("agent-company-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })
})
