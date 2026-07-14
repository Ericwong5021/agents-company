export function localAuthStorageKey(url: string) {
  return `agent-company.local-auth:${url}`
}

export function readLocalAuthToken(url: string) {
  if (typeof localStorage !== "object") return
  try {
    return localStorage.getItem(localAuthStorageKey(url)) ?? undefined
  } catch {
    return
  }
}

export function clearLocalAuthToken(url: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.removeItem(localAuthStorageKey(url))
  } catch {
    return
  }
}
