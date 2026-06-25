/**
 * YAML front-matter parser for workspace .md files.
 *
 * Extracts metadata (scope, classification, owner, updatedBy) from
 * Markdown files that begin with a `---` delimited YAML block.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrontMatter {
  scope?: string
  classification?: string
  owner?: string
  updatedBy?: string
  [key: string]: string | undefined
}

export interface ParsedDocument {
  frontMatter: FrontMatter
  body: string
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const DELIMITER = "---"

/**
 * Parse a Markdown string that may begin with YAML front-matter.
 * Returns the extracted metadata and the remaining body text.
 * If no front-matter is present, returns empty metadata and the full text.
 */
export function parseFrontMatter(content: string): ParsedDocument {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith(DELIMITER)) return { frontMatter: {}, body: content }

  // Find the closing delimiter (must be on its own line)
  const afterOpen = trimmed.slice(DELIMITER.length)
  const closeIdx = afterOpen.indexOf(`\n${DELIMITER}`)
  if (closeIdx === -1) return { frontMatter: {}, body: content }

  const yamlBlock = afterOpen.slice(0, closeIdx).trim()
  const body = afterOpen.slice(closeIdx + DELIMITER.length + 1).trimStart()

  return { frontMatter: parseSimpleYaml(yamlBlock), body }
}

/**
 * Serialize a front-matter object and body back into a Markdown string.
 */
export function stringifyFrontMatter(frontMatter: FrontMatter, body: string): string {
  const keys = Object.keys(frontMatter).filter((k) => frontMatter[k] !== undefined)
  if (keys.length === 0) return body
  const lines = keys.map((k) => `${k}: ${frontMatter[k]}`)
  return `---\n${lines.join("\n")}\n---\n\n${body}`
}

// ---------------------------------------------------------------------------
// Minimal YAML parser (handles flat key: value pairs only)
// ---------------------------------------------------------------------------

function parseSimpleYaml(block: string): FrontMatter {
  const result: FrontMatter = {}
  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key) result[key] = value || undefined
  }
  return result
}
