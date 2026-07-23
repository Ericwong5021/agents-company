/**
 * Maps the product Icon `name` API onto Phosphor Regular (default) / Fill assets.
 * Run: bun run script/generate-phosphor-icons.ts
 */
import { existsSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const assets = path.join(root, "node_modules", "@phosphor-icons", "core", "assets")
const out = path.join(root, "src", "components", "icons", "phosphor.ts")

type Weight = "regular" | "fill" | "light"

/** Existing Icon names → Phosphor file stem (+ optional weight). */
const map: Record<string, { file: string; weight?: Weight }> = {
  "align-right": { file: "text-align-right" },
  "arrow-up": { file: "arrow-up" },
  "arrow-left": { file: "arrow-left" },
  "arrow-right": { file: "arrow-right" },
  archive: { file: "archive" },
  "bubble-5": { file: "chat-circle" },
  prompt: { file: "chat-teardrop-text" },
  brain: { file: "brain" },
  fork: { file: "git-fork" },
  "bullet-list": { file: "list-bullets" },
  "check-small": { file: "check" },
  "chevron-down": { file: "caret-down" },
  "chevron-left": { file: "caret-left" },
  "chevron-right": { file: "caret-right" },
  "chevron-grabber-vertical": { file: "caret-up-down" },
  "chevron-double-right": { file: "caret-double-right" },
  "circle-x": { file: "x-circle" },
  close: { file: "x" },
  "close-small": { file: "x" },
  checklist: { file: "list-checks" },
  console: { file: "terminal" },
  terminal: { file: "terminal-window" },
  "terminal-active": { file: "terminal-window", weight: "fill" },
  review: { file: "notepad" },
  "review-active": { file: "notepad", weight: "fill" },
  expand: { file: "arrows-out-simple" },
  collapse: { file: "arrows-in-simple" },
  code: { file: "code" },
  "code-lines": { file: "text-align-left" },
  "circle-ban-sign": { file: "prohibit" },
  "edit-small-2": { file: "pencil-simple" },
  eye: { file: "eye" },
  enter: { file: "arrow-elbow-down-left" },
  folder: { file: "folder" },
  "file-tree": { file: "tree-structure" },
  "file-tree-active": { file: "tree-structure", weight: "fill" },
  "magnifying-glass": { file: "magnifying-glass" },
  "plus-small": { file: "plus" },
  plus: { file: "plus" },
  "pencil-line": { file: "pencil-simple-line" },
  mcp: { file: "plugs-connected" },
  glasses: { file: "eyeglasses" },
  "magnifying-glass-menu": { file: "list-magnifying-glass" },
  "window-cursor": { file: "cursor" },
  task: { file: "columns" },
  stop: { file: "stop" },
  status: { file: "rows" },
  "status-active": { file: "rows", weight: "fill" },
  sidebar: { file: "sidebar-simple" },
  "sidebar-active": { file: "sidebar-simple", weight: "fill" },
  "layout-left": { file: "sidebar" },
  "layout-left-partial": { file: "sidebar" },
  "layout-left-full": { file: "sidebar", weight: "fill" },
  "layout-right": { file: "sidebar" },
  "layout-right-partial": { file: "sidebar" },
  "layout-right-full": { file: "sidebar", weight: "fill" },
  "square-arrow-top-right": { file: "arrow-square-out" },
  "open-file": { file: "arrow-square-out" },
  "speech-bubble": { file: "chat-circle" },
  comment: { file: "chat-teardrop" },
  "folder-add-left": { file: "folder-plus" },
  github: { file: "github-logo" },
  discord: { file: "discord-logo" },
  "layout-bottom": { file: "rectangle" },
  "layout-bottom-partial": { file: "rectangle" },
  "layout-bottom-full": { file: "rectangle", weight: "fill" },
  "dot-grid": { file: "dots-three" },
  "circle-check": { file: "check-circle" },
  copy: { file: "copy" },
  check: { file: "check" },
  photo: { file: "image" },
  share: { file: "share-network" },
  shield: { file: "shield-check" },
  download: { file: "download-simple" },
  menu: { file: "list" },
  server: { file: "hard-drives" },
  branch: { file: "git-branch" },
  edit: { file: "pencil-simple" },
  help: { file: "question" },
  "settings-gear": { file: "gear" },
  dash: { file: "minus" },
  "cloud-upload": { file: "cloud-arrow-up" },
  trash: { file: "trash" },
  sliders: { file: "sliders" },
  keyboard: { file: "keyboard" },
  selector: { file: "caret-up-down" },
  "arrow-down-to-line": { file: "arrow-line-down" },
  warning: { file: "warning" },
  reset: { file: "arrow-counter-clockwise" },
  link: { file: "link" },
  providers: { file: "cpu" },
  models: { file: "sparkle" },
}

function extractInner(svg: string) {
  const match = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/i)
  if (!match) throw new Error("invalid svg")
  return match[1].trim().replace(/\s+/g, " ")
}

const missing: string[] = []
const entries: string[] = []

for (const [name, spec] of Object.entries(map)) {
  const weight = spec.weight ?? "regular"
  const stem = weight === "regular" || weight === "light" ? spec.file : `${spec.file}-${weight}`
  const file = path.join(assets, weight, `${stem}.svg`)
  if (!existsSync(file)) {
    missing.push(`${name} → ${weight}/${stem}.svg`)
    continue
  }
  const inner = extractInner(await Bun.file(file).text())
  entries.push(`  ${JSON.stringify(name)}: ${JSON.stringify(inner)},`)
}

if (missing.length) {
  console.error("Missing Phosphor assets:\n" + missing.join("\n"))
  process.exit(1)
}

const source = `/* Generated by script/generate-phosphor-icons.ts — do not edit by hand. */
export const phosphorIcons = {
${entries.join("\n")}
} as const

export type PhosphorIconName = keyof typeof phosphorIcons
export const PHOSPHOR_VIEWBOX = "0 0 256 256"
`

await Bun.write(out, source)
console.log(`Wrote ${entries.length} icons → ${path.relative(root, out)}`)
