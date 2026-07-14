import Store from "electron-store"

import { SETTINGS_STORE } from "./constants"

const cache = new Map<string, Store>()

// We cannot instantiate electron-store at module load time because import hoisting
// runs before index.ts sets the Agent Company user-data directory.
export function getStore(name: string = SETTINGS_STORE) {
  const cached = cache.get(name)
  if (cached) return cached
  const next = new Store({ name, fileExtension: "", accessPropertiesByDotNotation: false })
  cache.set(name, next)
  return next
}
