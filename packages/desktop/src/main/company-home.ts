import path from "node:path"

export type LauncherState =
  | { state: "needs_company_home"; suggested_path: string }
  | { state: "ready"; company_home: string }

export function normalizeCompanyHome(companyHome: string) {
  if (!path.isAbsolute(companyHome)) throw new Error("Company home must be an absolute path")
  return path.resolve(companyHome)
}

export function launcherState(companyHome: string | null, documents: string): LauncherState {
  if (!companyHome) {
    return {
      state: "needs_company_home",
      suggested_path: path.join(documents, "Agent Company"),
    }
  }
  return { state: "ready", company_home: normalizeCompanyHome(companyHome) }
}

export async function loadCompanyRuntime<T>(companyHome: string, load: () => Promise<T>) {
  process.env.AGENTCOMPANY_HOME = normalizeCompanyHome(companyHome)
  return load()
}
