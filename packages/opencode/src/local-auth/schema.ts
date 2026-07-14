import { NamedError } from "@agents-company/shared/util/error"
import z from "zod"

export const LocalAuthSession = z
  .object({
    authenticated: z.literal(true),
    kind: z.enum(["trusted", "basic", "bearer"]),
    credential_id: z.string().optional(),
  })
  .strict()
  .meta({ ref: "LocalAuthSession" })
export type LocalAuthSession = z.infer<typeof LocalAuthSession>

export const LocalPairingInput = z
  .object({
    label: z.string().trim().min(1).max(80),
  })
  .strict()
  .meta({ ref: "LocalPairingInput" })
export type LocalPairingInput = z.infer<typeof LocalPairingInput>

export const LocalPairing = z
  .object({
    code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
    label: z.string().min(1).max(80),
    expires_at: z.number().int(),
    pairing_url: z.string().url(),
  })
  .strict()
  .meta({ ref: "LocalPairing" })
export type LocalPairing = z.infer<typeof LocalPairing>

export const LocalExchangeInput = z
  .object({
    code: z.string().min(8).max(9),
    label: z.string().trim().min(1).max(80),
  })
  .strict()
  .meta({ ref: "LocalExchangeInput" })
export type LocalExchangeInput = z.infer<typeof LocalExchangeInput>

export const LocalCredential = z
  .object({
    id: z.string().startsWith("lcr_"),
    label: z.string(),
    created_at: z.number().int(),
    last_used_at: z.number().int().nullable(),
    revoked_at: z.number().int().nullable(),
  })
  .strict()
  .meta({ ref: "LocalCredential" })
export type LocalCredential = z.infer<typeof LocalCredential>

export const IssuedCredential = z
  .object({
    credential_id: z.string().startsWith("lcr_"),
    label: z.string(),
    token: z.string().startsWith("ac1_"),
    created_at: z.number().int(),
  })
  .strict()
  .meta({ ref: "IssuedCredential" })
export type IssuedCredential = z.infer<typeof IssuedCredential>

export const LocalAuthUnauthorized = NamedError.create("LocalAuthUnauthorized", z.object({}).strict())
export const LocalAuthForbidden = NamedError.create("LocalAuthForbidden", z.object({}).strict())
export const LocalPairingInvalidOrExpired = NamedError.create(
  "LocalPairingInvalidOrExpired",
  z.object({}).strict(),
)
