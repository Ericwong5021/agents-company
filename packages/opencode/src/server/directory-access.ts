import { RepositoryBindingTable } from "@/company/company.sql"
import { Database } from "@/storage"
import { Filesystem } from "@/util"

export function isInstanceDirectoryAllowed(directory: string) {
  if (Filesystem.contains(Filesystem.resolve(process.cwd()), directory)) return true
  return Database.use((db) =>
    db
      .select({ root_path: RepositoryBindingTable.root_path })
      .from(RepositoryBindingTable)
      .all()
      .some((row) => Filesystem.contains(Filesystem.resolve(row.root_path), directory)),
  )
}
