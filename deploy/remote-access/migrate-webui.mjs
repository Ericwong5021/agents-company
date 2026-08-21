import fs from "node:fs/promises"
import { createClient } from "@libsql/client"

const client = createClient({ url: "file:/data/db/sqlite.db" })
const existing = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'")

if (existing.rows.length === 0) {
  const migration = await fs.readFile(new URL("./db/migrations/sqlite/0000_initial.sql", import.meta.url), "utf8")
  await client.executeMultiple(migration.replaceAll("--> statement-breakpoint", ""))
}

client.close()
