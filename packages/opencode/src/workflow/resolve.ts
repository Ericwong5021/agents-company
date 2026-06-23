import path from "path"
import { Filesystem } from "@/util"
import { Global } from "@/global"

// A first arg to workflow() is an inline script when it contains the mandatory
// meta export anywhere (real scripts may have a leading comment/whitespace);
// otherwise it is a bare saved-workflow name to resolve from the workflows dir.
const META_RE = /export\s+const\s+meta\s*=/

export function isInlineScript(nameOrScript: string): boolean {
  return META_RE.test(nameOrScript)
}

// Saved workflows are shared Agent Company definitions. A bare name is
// constrained to a single path segment so it can never inject a separator and
// escape the workflows dir.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/

export async function resolveWorkflowScript(name: string, start: string, stop: string): Promise<string | null> {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid workflow name: ${JSON.stringify(name)}`)
  const candidate = path.join(Global.Path.config, "workflows", `${name}.js`)
  if (await Filesystem.exists(candidate)) return Filesystem.readText(candidate)
  return null
}
