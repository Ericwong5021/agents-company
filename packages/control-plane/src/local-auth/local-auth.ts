import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { and, Database, desc, eq, isNull } from "@/storage"
import { Identifier } from "@/id/id"
import { LocalClientCredentialTable } from "./local-auth.sql"
import {
  IssuedCredential,
  LocalAuthSession,
  LocalCredential,
  LocalExchangeInput,
  LocalPairingInput,
  LocalPairingInvalidOrExpired,
  type IssuedCredential as IssuedCredentialType,
  type LocalAuthSession as LocalAuthSessionType,
  type LocalCredential as LocalCredentialType,
  type LocalExchangeInput as LocalExchangeInputType,
  type LocalPairingInput as LocalPairingInputType,
} from "./schema"

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const PAIRING_TTL = 5 * 60 * 1000

export type PairingChallenge = {
  code: string
  label: string
  expires_at: number
}

const pairings = new Map<string, PairingChallenge>()

function pairingCode() {
  const raw = Array.from(randomBytes(8), (value) => ALPHABET[value % ALPHABET.length]).join("")
  return raw.slice(0, 4) + "-" + raw.slice(4)
}

function nextPairingCode(): string {
  const code = pairingCode()
  return pairings.has(code) ? nextPairingCode() : code
}

function digest(secret: string) {
  return createHash("sha256").update(secret).digest("hex")
}

function normalizeCode(code: string) {
  const raw = code.replaceAll("-", "").toUpperCase()
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(raw)) return
  return raw.slice(0, 4) + "-" + raw.slice(4)
}

function clearExpiredPairings(now: number) {
  pairings.forEach((pairing, code) => {
    if (pairing.expires_at <= now) pairings.delete(code)
  })
}

function credential(row: typeof LocalClientCredentialTable.$inferSelect): LocalCredentialType {
  return LocalCredential.parse({
    id: row.id,
    label: row.label,
    created_at: row.time_created,
    last_used_at: row.time_last_used,
    revoked_at: row.time_revoked,
  })
}

export interface Interface {
  readonly createPairing: (input: LocalPairingInputType) => Effect.Effect<PairingChallenge>
  readonly exchange: (input: LocalExchangeInputType) => Effect.Effect<
    IssuedCredentialType,
    InstanceType<typeof LocalPairingInvalidOrExpired>
  >
  readonly verify: (token: string) => Effect.Effect<LocalAuthSessionType | undefined>
  readonly list: () => Effect.Effect<LocalCredentialType[]>
  readonly revoke: (id: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@control-plane/LocalAuth") {}

const createPairing = Effect.fn("LocalAuth.createPairing")(function (input: LocalPairingInputType) {
  return Effect.sync(() => {
    const next = LocalPairingInput.parse(input)
    const now = Date.now()
    clearExpiredPairings(now)
    const pairing = {
      code: nextPairingCode(),
      label: next.label,
      expires_at: now + PAIRING_TTL,
    }
    pairings.set(pairing.code, pairing)
    return pairing
  })
})

const exchange = Effect.fn("LocalAuth.exchange")(function (input: LocalExchangeInputType) {
  return Effect.suspend(() => {
    const parsed = LocalExchangeInput.safeParse(input)
    const code = parsed.success ? normalizeCode(parsed.data.code) : undefined
    const pairing = code ? pairings.get(code) : undefined
    if (!parsed.success || !code || !pairing || pairing.expires_at <= Date.now() || pairing.label !== parsed.data.label)
      return Effect.fail(new LocalPairingInvalidOrExpired({}))

    const now = Date.now()
    const credentialID = Identifier.ascending("localCredential")
    const secret = randomBytes(32).toString("hex")
    const token = `ac1_${credentialID}_${secret}`
    Database.transaction(
      (tx) => {
        tx.insert(LocalClientCredentialTable)
          .values({
            id: credentialID,
            token_hash: digest(secret),
            label: pairing.label,
            time_last_used: null,
            time_revoked: null,
            time_created: now,
            time_updated: now,
          })
          .run()
      },
      { behavior: "immediate" },
    )
    pairings.delete(code)
    return Effect.succeed(
      IssuedCredential.parse({
        credential_id: credentialID,
        label: pairing.label,
        token,
        created_at: now,
      }),
    )
  })
})

const verify = Effect.fn("LocalAuth.verify")(function (token: string) {
  return Effect.sync(() => {
    const separator = token.lastIndexOf("_")
    const credentialID = token.slice("ac1_".length, separator)
    const secret = token.slice(separator + 1)
    if (!token.startsWith("ac1_") || !credentialID.startsWith("lcr_") || !secret) return

    const row = Database.use((db) =>
      db
        .select()
        .from(LocalClientCredentialTable)
        .where(and(eq(LocalClientCredentialTable.id, credentialID), isNull(LocalClientCredentialTable.time_revoked)))
        .get(),
    )
    if (!row) return

    const hash = digest(secret)
    if (row.token_hash.length !== hash.length || !timingSafeEqual(Buffer.from(hash), Buffer.from(row.token_hash))) return

    const now = Date.now()
    Database.use((db) =>
      db
        .update(LocalClientCredentialTable)
        .set({ time_last_used: now, time_updated: now })
        .where(eq(LocalClientCredentialTable.id, credentialID))
        .run(),
    )
    return LocalAuthSession.parse({ authenticated: true, kind: "bearer", credential_id: credentialID })
  })
})

const list = Effect.fn("LocalAuth.list")(() =>
  Effect.sync(() =>
    Database.use((db) => db.select().from(LocalClientCredentialTable).orderBy(desc(LocalClientCredentialTable.time_created)).all().map(credential)),
  ),
)

const revoke = Effect.fn("LocalAuth.revoke")(function (id: string) {
  return Effect.sync(() => {
    const now = Date.now()
    Database.use((db) =>
      db
        .update(LocalClientCredentialTable)
        .set({ time_revoked: now, time_updated: now })
        .where(and(eq(LocalClientCredentialTable.id, id), isNull(LocalClientCredentialTable.time_revoked)))
        .run(),
    )
  })
})

export const layer = Layer.succeed(Service, Service.of({ createPairing, exchange, verify, list, revoke }))

export const defaultLayer = layer
