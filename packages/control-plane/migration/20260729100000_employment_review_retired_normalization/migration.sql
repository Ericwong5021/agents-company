PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE company_employment_review_normalized (
  id text PRIMARY KEY NOT NULL,
  company_id text NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES company_agent(id),
  status text NOT NULL,
  selected_project_count integer NOT NULL,
  successful_project_count integer NOT NULL,
  average_quality_score integer NOT NULL,
  average_reliability_score integer NOT NULL,
  recurring_need_count integer NOT NULL,
  rationale text NOT NULL,
  decision_note text,
  time_decided integer,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  CONSTRAINT company_employment_review_status_check CHECK (status IN ('proposed', 'approved', 'rejected')),
  CONSTRAINT company_employment_review_counts_check CHECK (
    selected_project_count >= 0 AND successful_project_count >= 0 AND recurring_need_count >= 0
  ),
  CONSTRAINT company_employment_review_quality_check CHECK (
    average_quality_score BETWEEN 0 AND 100 AND average_reliability_score BETWEEN 0 AND 100
  )
);
--> statement-breakpoint
INSERT INTO company_employment_review_normalized (
  id,
  company_id,
  agent_id,
  status,
  selected_project_count,
  successful_project_count,
  average_quality_score,
  average_reliability_score,
  recurring_need_count,
  rationale,
  decision_note,
  time_decided,
  time_created,
  time_updated
)
SELECT
  id,
  company_id,
  agent_id,
  CASE status WHEN 'retired' THEN 'rejected' ELSE status END,
  selected_project_count,
  successful_project_count,
  average_quality_score,
  average_reliability_score,
  recurring_need_count,
  rationale,
  CASE
    WHEN status = 'retired' AND decision_note IS NULL
      THEN '[legacy_status=retired; normalized_by=20260729100000_employment_review_retired_normalization]'
    WHEN status = 'retired'
      THEN decision_note || char(10) || '[legacy_status=retired; normalized_by=20260729100000_employment_review_retired_normalization]'
    ELSE decision_note
  END,
  time_decided,
  time_created,
  time_updated
FROM company_employment_review;
--> statement-breakpoint
DROP TABLE company_employment_review;
--> statement-breakpoint
ALTER TABLE company_employment_review_normalized RENAME TO company_employment_review;
--> statement-breakpoint
CREATE INDEX company_employment_review_agent_status_idx ON company_employment_review(agent_id, status, time_created);
