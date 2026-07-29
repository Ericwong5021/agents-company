import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { CompanyRecruitment } from "../../src/company-recruitment"
import { CompanyEmploymentReviewTable } from "../../src/company-recruitment/company-recruitment.sql"
import { CompanyID } from "../../src/company/schema"
import { Database } from "../../src/storage"

const companyID = CompanyID.parse(process.argv[2])
const snapshot = await Effect.runPromise(
  CompanyRecruitment.Service.use((service) => service.snapshot({ company_id: companyID })).pipe(
    Effect.provide(CompanyRecruitment.defaultLayer),
  ),
)
const rawReview = Database.use((db) =>
  db
    .select({
      id: CompanyEmploymentReviewTable.id,
      status: CompanyEmploymentReviewTable.status,
      rationale: CompanyEmploymentReviewTable.rationale,
      decision_note: CompanyEmploymentReviewTable.decision_note,
      time_decided: CompanyEmploymentReviewTable.time_decided,
      time_created: CompanyEmploymentReviewTable.time_created,
      time_updated: CompanyEmploymentReviewTable.time_updated,
    })
    .from(CompanyEmploymentReviewTable)
    .where(eq(CompanyEmploymentReviewTable.id, "review-retired"))
    .get(),
)

console.log(
  JSON.stringify({
    snapshotReview: snapshot.employment_reviews.find((review) => review.id === "review-retired"),
    rawReview,
  }),
)
Database.close()
