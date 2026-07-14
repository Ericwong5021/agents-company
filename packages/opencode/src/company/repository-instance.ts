import { Context, Effect } from "effect"
import { NamedError } from "@agents-company/shared/util/error"
import z from "zod"
import { InstanceRef } from "@/effect/instance-ref"
import { Instance } from "@/project/instance"
import { Database, eq } from "@/storage"
import { RepositoryBindingTable } from "./company.sql"
import { CompanyID } from "./schema"

export const RepositoryBindingNotFound = NamedError.create(
  "RepositoryBindingNotFound",
  z.object({ company_id: CompanyID }).strict(),
)

export const Binding = z
  .object({
    companyID: CompanyID,
    projectID: z.string(),
    rootPath: z.string().min(1),
  })
  .strict()
export type Binding = z.infer<typeof Binding>

export const get = Effect.fn("RepositoryInstance.get")(function* (companyID: CompanyID) {
  const binding = yield* Effect.sync(() =>
    Database.use((db) =>
      db.select().from(RepositoryBindingTable).where(eq(RepositoryBindingTable.company_id, companyID)).get(),
    ),
  )
  if (!binding) return yield* Effect.fail(new RepositoryBindingNotFound({ company_id: companyID }))
  return Binding.parse({
    companyID: binding.company_id,
    projectID: binding.project_id,
    rootPath: binding.root_path,
  })
})

/**
 * Re-enters the actual repository bound to a Company while preserving the
 * caller's Effect services. Board execution must never run in the temporary
 * bootstrap runtime used only for Company setup.
 */
export const provide =
  (companyID: CompanyID) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | InstanceType<typeof RepositoryBindingNotFound>, R> =>
    Effect.gen(function* () {
      const binding = yield* get(companyID)
      return yield* Effect.contextWith((services: Context.Context<R>) =>
        Effect.promise<A>(() =>
          Instance.provide({
            directory: binding.rootPath,
            fn: () => Effect.runPromiseWith(services)(self.pipe(Effect.provideService(InstanceRef, Instance.current))),
          }),
        ),
      )
    })

export * as RepositoryInstance from "./repository-instance"
