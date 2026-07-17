import path from "node:path"

export type CompanyEntryState =
  | { state: "needs_bootstrap"; data_directory: string }
  | { state: "ready"; repository_path: string }

export function decideCompanyEntry(state: CompanyEntryState, cwd: string) {
  if (state.state === "needs_bootstrap") {
    return { type: "setup_required" as const, data_directory: state.data_directory }
  }

  const relative = path.relative(state.repository_path, cwd)
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return { type: "ready" as const }
  }

  return { type: "repository_mismatch" as const, repository_path: state.repository_path }
}
