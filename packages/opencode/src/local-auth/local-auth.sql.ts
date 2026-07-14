import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"

export const LocalClientCredentialTable = sqliteTable(
  "local_client_credential",
  {
    id: text().primaryKey(),
    token_hash: text().notNull(),
    label: text().notNull(),
    time_last_used: integer(),
    time_revoked: integer(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("local_client_credential_hash_idx").on(table.token_hash)],
)
