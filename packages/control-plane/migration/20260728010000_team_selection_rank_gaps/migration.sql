ALTER TABLE company_team_selection ADD COLUMN candidate_rank integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE company_team_selection ADD COLUMN gaps_json text NOT NULL DEFAULT '[]';
