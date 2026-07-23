import { desc } from "drizzle-orm"
import { Database } from "@/storage"
import { CompanyProjectTable } from "./company-project.sql"

export async function listCompanyProjectSummaries() {
  return Database.use((db) =>
    db
      .select({
        id: CompanyProjectTable.id,
        title: CompanyProjectTable.title,
        goal: CompanyProjectTable.goal,
        status: CompanyProjectTable.status,
        updated_at: CompanyProjectTable.updated_at,
      })
      .from(CompanyProjectTable)
      .orderBy(desc(CompanyProjectTable.updated_at))
      .all(),
  )
}
