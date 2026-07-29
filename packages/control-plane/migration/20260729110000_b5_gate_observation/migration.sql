CREATE TABLE `company_gate_observation` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `paired_project_id` text REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `candidate_sha` text NOT NULL CHECK (length(`candidate_sha`) = 40 AND `candidate_sha` NOT GLOB '*[^0-9a-f]*'),
  `scenario_id` text NOT NULL,
  `run_id` text NOT NULL,
  `subject_id` text NOT NULL,
  `strategy` text NOT NULL CHECK (`strategy` IN ('legacy_full_plan', 'seed_and_grow')),
  `snapshot_sha256` text NOT NULL CHECK (length(`snapshot_sha256`) = 64 AND `snapshot_sha256` NOT GLOB '*[^0-9a-f]*'),
  `event_type` text NOT NULL,
  `properties_json` text NOT NULL,
  `source_refs_json` text NOT NULL,
  `evidence_json` text NOT NULL,
  `producer_path` text NOT NULL,
  `producer_sha256` text NOT NULL CHECK (length(`producer_sha256`) = 64 AND `producer_sha256` NOT GLOB '*[^0-9a-f]*'),
  `input_sha256` text NOT NULL CHECK (length(`input_sha256`) = 64 AND `input_sha256` NOT GLOB '*[^0-9a-f]*'),
  `created_at` integer NOT NULL CHECK (`created_at` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_gate_observation_run_event_idx`
ON `company_gate_observation` (`run_id`, `event_type`, `subject_id`);
--> statement-breakpoint
CREATE INDEX `company_gate_observation_project_idx`
ON `company_gate_observation` (`project_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `company_gate_observation_candidate_idx`
ON `company_gate_observation` (`candidate_sha`, `scenario_id`, `strategy`);
