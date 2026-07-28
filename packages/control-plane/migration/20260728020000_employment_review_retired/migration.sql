CREATE TABLE company_employment_review_new (
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
  CONSTRAINT company_employment_review_status_check CHECK (status IN ('proposed', 'approved', 'rejected', 'retired')),
  CONSTRAINT company_employment_review_counts_check CHECK (
    selected_project_count >= 0 AND successful_project_count >= 0 AND recurring_need_count >= 0
  ),
  CONSTRAINT company_employment_review_quality_check CHECK (
    average_quality_score BETWEEN 0 AND 100 AND average_reliability_score BETWEEN 0 AND 100
  )
);
--> statement-breakpoint
INSERT INTO company_employment_review_new SELECT * FROM company_employment_review;
--> statement-breakpoint
DROP TABLE company_employment_review;
--> statement-breakpoint
ALTER TABLE company_employment_review_new RENAME TO company_employment_review;
--> statement-breakpoint
CREATE INDEX company_employment_review_agent_status_idx ON company_employment_review(agent_id, status, time_created);
