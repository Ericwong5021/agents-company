CREATE TABLE `company_approval_gate_w2` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text,
  `company_id` text,
  `scope_type` text DEFAULT 'project' NOT NULL,
  `pre_project_id` text,
  `decision_id` text,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `title` text NOT NULL,
  `summary` text NOT NULL,
  `requested_by_agent_id` text,
  `requested_by_actor_kind` text,
  `requested_by_actor_id` text,
  `work_item_id` text,
  `resource_scope_json` text DEFAULT '[]' NOT NULL,
  `worktree_run_id` text,
  `decision_note` text,
  `requested_at` integer NOT NULL,
  `decided_at` integer,
  FOREIGN KEY (`project_id`) REFERENCES `company_project`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `company`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`decision_id`) REFERENCES `founder_decision_record`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`work_item_id`) REFERENCES `company_work_item`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`worktree_run_id`) REFERENCES `company_worktree_run`(`id`) ON UPDATE no action ON DELETE set null,
  CONSTRAINT `company_approval_gate_scope_w2_check` CHECK (
    (`scope_type` = 'project' AND `project_id` IS NOT NULL AND `pre_project_id` IS NULL)
    OR (`scope_type` = 'company' AND `project_id` IS NULL AND `pre_project_id` IS NULL AND `company_id` IS NOT NULL)
    OR (`scope_type` = 'pre_project' AND `project_id` IS NULL AND `pre_project_id` IS NOT NULL AND `company_id` IS NOT NULL)
  ),
  CONSTRAINT `company_approval_gate_founder_actor_check` CHECK (
    `kind` != 'founder_red'
    OR (
      `decision_id` IS NOT NULL
      AND `requested_by_actor_kind` IN ('human','ai_founder','board','policy_engine')
      AND `requested_by_actor_id` IS NOT NULL
    )
  )
);
--> statement-breakpoint
INSERT INTO `company_approval_gate_w2` (
  `id`,`project_id`,`company_id`,`scope_type`,`pre_project_id`,`decision_id`,`kind`,`status`,`title`,`summary`,
  `requested_by_agent_id`,`requested_by_actor_kind`,`requested_by_actor_id`,`work_item_id`,`resource_scope_json`,
  `worktree_run_id`,`decision_note`,`requested_at`,`decided_at`
)
SELECT
  gate.`id`,gate.`project_id`,project.`company_id`,'project',NULL,NULL,gate.`kind`,gate.`status`,gate.`title`,gate.`summary`,
  gate.`requested_by_agent_id`,NULL,NULL,gate.`work_item_id`,gate.`resource_scope_json`,
  gate.`worktree_run_id`,gate.`decision_note`,gate.`requested_at`,gate.`decided_at`
FROM `company_approval_gate` gate
LEFT JOIN `company_project` project ON project.`id` = gate.`project_id`;
--> statement-breakpoint
DROP TABLE `company_approval_gate`;
--> statement-breakpoint
ALTER TABLE `company_approval_gate_w2` RENAME TO `company_approval_gate`;
--> statement-breakpoint
CREATE INDEX `company_approval_gate_project_idx` ON `company_approval_gate` (`project_id`,`status`);
--> statement-breakpoint
CREATE INDEX `company_approval_gate_project_kind_status_idx` ON `company_approval_gate` (`project_id`,`kind`,`status`);
--> statement-breakpoint
CREATE INDEX `company_approval_gate_work_item_idx` ON `company_approval_gate` (`work_item_id`,`status`);
--> statement-breakpoint
CREATE INDEX `company_approval_gate_company_scope_idx` ON `company_approval_gate` (`company_id`,`scope_type`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_approval_gate_pending_decision_idx` ON `company_approval_gate` (`decision_id`) WHERE `status` = 'pending' AND `decision_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `company_outcome_signal_w2` (
  `id` text PRIMARY KEY NOT NULL,
  `schema_version` integer NOT NULL,
  `project_id` text NOT NULL,
  `decision_id` text,
  `idempotency_key` text NOT NULL,
  `result` text NOT NULL,
  `summary` text NOT NULL,
  `validator_kind` text NOT NULL,
  `validator_id` text NOT NULL,
  `source_refs_json` text NOT NULL,
  `observed_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `company_project`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`decision_id`) REFERENCES `founder_decision_record`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `company_outcome_signal_w2` (
  `id`,`schema_version`,`project_id`,`decision_id`,`idempotency_key`,`result`,`summary`,
  `validator_kind`,`validator_id`,`source_refs_json`,`observed_at`,`created_at`
)
SELECT
  signal.`id`,signal.`schema_version`,signal.`project_id`,
  CASE
    WHEN EXISTS (SELECT 1 FROM `founder_decision_record` decision WHERE decision.`id` = signal.`decision_id`)
    THEN signal.`decision_id`
    ELSE NULL
  END,
  signal.`idempotency_key`,signal.`result`,signal.`summary`,signal.`validator_kind`,signal.`validator_id`,
  signal.`source_refs_json`,signal.`observed_at`,signal.`created_at`
FROM `company_outcome_signal` signal;
--> statement-breakpoint
DROP TABLE `company_outcome_signal`;
--> statement-breakpoint
ALTER TABLE `company_outcome_signal_w2` RENAME TO `company_outcome_signal`;
--> statement-breakpoint
CREATE UNIQUE INDEX `company_outcome_signal_project_idempotency_idx` ON `company_outcome_signal` (`project_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `company_outcome_signal_project_created_idx` ON `company_outcome_signal` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `company_outcome_signal_decision_idx` ON `company_outcome_signal` (`decision_id`);
--> statement-breakpoint
CREATE TABLE `founder_decision_correction` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL,
  `decision_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `kind` text NOT NULL,
  `original_decision` text,
  `human_decision` text NOT NULL,
  `reason` text NOT NULL,
  `proposed_asset_updates_json` text NOT NULL,
  `actor_id` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`company_id`) REFERENCES `company`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`decision_id`) REFERENCES `founder_decision_record`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `founder_decision_correction_kind_check` CHECK (`kind` IN ('override','correction')),
  CONSTRAINT `founder_decision_correction_asset_authority_check` CHECK (
    `proposed_asset_updates_json` NOT LIKE '%"authority":"human_%'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `founder_decision_correction_idempotency_idx` ON `founder_decision_correction` (`company_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `founder_decision_correction_decision_idx` ON `founder_decision_correction` (`decision_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `founder_governance_event` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL,
  `scope_type` text NOT NULL,
  `scope_key` text NOT NULL,
  `decision_id` text NOT NULL,
  `gate_id` text,
  `type` text NOT NULL,
  `actor_kind` text NOT NULL,
  `actor_id` text NOT NULL,
  `data_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`company_id`) REFERENCES `company`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`decision_id`) REFERENCES `founder_decision_record`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `founder_governance_event_decision_idx` ON `founder_governance_event` (`decision_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `founder_governance_event_scope_idx` ON `founder_governance_event` (`company_id`,`scope_type`,`scope_key`);
