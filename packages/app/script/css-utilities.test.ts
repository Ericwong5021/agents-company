import { describe, expect, test } from "bun:test"

describe("production CSS", () => {
  test("contains core Tailwind utilities used by the shared app shell", async () => {
    const files = [...new Bun.Glob("assets/*.css").scanSync({ cwd: "dist", absolute: true })]
    expect(files.length).toBeGreaterThan(0)

    const css = (await Promise.all(files.map((file) => Bun.file(file).text()))).join("\n")

    expect(css).toContain(".flex{display:flex}")
    expect(css).toContain(".grid{display:grid}")
    expect(css).toContain(".hidden{display:none}")
    expect(css).toContain(".h-10{height:calc(var(--spacing)*10)}")
  })
})
