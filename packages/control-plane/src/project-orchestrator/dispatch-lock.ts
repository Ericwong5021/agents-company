import { Effect, Semaphore } from "effect"

const locks = new Map<string, Semaphore.Semaphore>()

const lock = (projectID: string) => {
  const existing = locks.get(projectID)
  if (existing) return existing
  const created = Semaphore.makeUnsafe(1)
  locks.set(projectID, created)
  return created
}

export const withProjectDispatchLock = <A, E, R>(projectID: string, effect: Effect.Effect<A, E, R>) =>
  lock(projectID).withPermits(1)(effect)
