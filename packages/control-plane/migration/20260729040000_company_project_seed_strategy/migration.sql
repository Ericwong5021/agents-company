ALTER TABLE company_project
ADD COLUMN execution_strategy text NOT NULL DEFAULT 'legacy_full_plan'
CHECK (execution_strategy IN ('legacy_full_plan', 'seed_and_grow'));
--> statement-breakpoint
ALTER TABLE company_project
ADD COLUMN seed_mode text
CHECK (seed_mode IS NULL OR seed_mode IN ('direct_single', 'seed_pair', 'discovery_first'));
