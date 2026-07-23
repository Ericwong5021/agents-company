import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dir, "..")
const bridge = path.join(packageRoot, "agent", "shared")
const target = path.join(packageRoot, "shared")

mkdirSync(path.join(packageRoot, ".nuxt"), { recursive: true })

if (!existsSync(bridge)) {
  symlinkSync(target, bridge, process.platform === "win32" ? "junction" : "dir")
  console.log("Generated Eve shared-runtime bridge.")
  process.exit(0)
}

if (lstatSync(bridge).isDirectory()) process.exit(0)
if (lstatSync(bridge).isSymbolicLink() && realpathSync(bridge) === realpathSync(target)) process.exit(0)
throw new Error(`Expected ${bridge} to be the generated link to ${target}.`)
