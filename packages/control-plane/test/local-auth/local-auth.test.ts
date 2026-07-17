import { describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { LocalAuth } from "../../src/local-auth"
import { LocalClientCredentialTable } from "../../src/local-auth/local-auth.sql"
import { Database, eq } from "../../src/storage"

describe.serial("LocalAuth", () => {
  test.serial("issues one token, stores no plaintext, and revokes it", async () => {
    const pairing = await AppRuntime.runPromise(
      LocalAuth.Service.use((service) => service.createPairing({ label: "Chrome on this Mac" })),
    )
    const issued = await AppRuntime.runPromise(
      LocalAuth.Service.use((service) => service.exchange({ code: pairing.code, label: pairing.label })),
    )

    expect(issued.token).toStartWith("ac1_")
    const stored = Database.use((db) =>
      db.select().from(LocalClientCredentialTable).where(eq(LocalClientCredentialTable.id, issued.credential_id)).get(),
    )
    expect(stored?.token_hash).toHaveLength(64)
    expect(JSON.stringify(stored)).not.toContain(issued.token.slice(issued.token.lastIndexOf("_") + 1))
    expect(await AppRuntime.runPromise(LocalAuth.Service.use((service) => service.verify(issued.token)))).toMatchObject({
      kind: "bearer",
      credential_id: issued.credential_id,
    })
    await expect(
      AppRuntime.runPromise(LocalAuth.Service.use((service) => service.exchange({ code: pairing.code, label: pairing.label }))),
    ).rejects.toMatchObject({ name: "LocalPairingInvalidOrExpired" })

    await AppRuntime.runPromise(LocalAuth.Service.use((service) => service.revoke(issued.credential_id)))
    expect(await AppRuntime.runPromise(LocalAuth.Service.use((service) => service.verify(issued.token)))).toBeUndefined()
  })

  test.serial("atomically exchanges a pairing only once", async () => {
    const pairing = await AppRuntime.runPromise(
      LocalAuth.Service.use((service) => service.createPairing({ label: "Concurrent browser" })),
    )
    const results = await Promise.allSettled(
      [pairing, pairing].map(() =>
        AppRuntime.runPromise(LocalAuth.Service.use((service) => service.exchange({ code: pairing.code, label: pairing.label }))),
      ),
    )

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  })
})
