import path from "node:path"
import fs from "node:fs"

export type Migration = { sql: string; timestamp: number; name: string }

export async function loadMigrations(root: string): Promise<Migration[]> {
  return Promise.all(
    (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: path.join(root, "migration") })))
      .map((file) => path.dirname(file))
      .filter((name) => /^\d{14}/.test(name))
      .sort()
      .map(async (name) => {
        const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
        if (!match) throw new Error("Invalid migration directory: " + name)
        return {
          name,
          sql: await Bun.file(path.join(root, "migration", name, "migration.sql")).text(),
          timestamp: Date.UTC(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]),
            Number(match[4]),
            Number(match[5]),
            Number(match[6]),
          ),
        }
      }),
  )
}

export async function createEmbeddedWebUIBundle(root: string) {
  const app = path.join(root, "../app")
  const build = Bun.spawn({
    cmd: ["bun", "run", "build"],
    cwd: app,
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await build.exited) !== 0) throw new Error("WebUI build failed")

  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: path.join(app, "dist") }))).sort()
  const imports = files.map((file, index) => {
    const spec = path.relative(root, path.join(app, "dist", file)).replaceAll("\\", "/")
    return `import file_${index} from ${JSON.stringify(spec.startsWith(".") ? spec : "./" + spec)} with { type: "file" };`
  })
  return [
    ...imports,
    "export default {",
    ...files.map((file, index) => "  " + JSON.stringify(file.replaceAll("\\", "/")) + ": file_" + index + ","),
    "};",
  ].join("\n")
}

export function createExtensionManifest(root: string) {
  const ext = path.join(root, "src", "ext")
  const overlay = path.resolve(root, "../../mimoapi/packages/opencode/src/ext")
  const staged = !fs.existsSync(ext) && fs.existsSync(overlay)
  if (staged) fs.cpSync(overlay, ext, { recursive: true })

  const created = !fs.existsSync(ext)
  if (created) fs.mkdirSync(ext, { recursive: true })

  const files = fs
    .readdirSync(ext)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts") && file !== "_manifest.ts")
    .sort()
  fs.writeFileSync(
    path.join(ext, "_manifest.ts"),
    `${files.map((file, index) => `import * as m${index} from "./${file.replace(/\.ts$/, "")}"`).join("\n")}\nexport const modules: Record<string, Record<string, unknown>> = Object.fromEntries([\n${files.map((file, index) => `  ["${file.replace(/\.ts$/, "")}", m${index}],`).join("\n")}\n])\n`,
  )

  return () => {
    if (staged || created) {
      fs.rmSync(ext, { recursive: true, force: true })
      return
    }
    fs.rmSync(path.join(ext, "_manifest.ts"), { force: true })
  }
}
