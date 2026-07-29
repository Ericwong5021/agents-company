CREATE TABLE `company_attention` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `issue_kind` text NOT NULL,
  `risk` text NOT NULL,
  `materiality` text NOT NULL,
  `route` text NOT NULL,
  `material` integer NOT NULL,
  `interrupts_user` integer NOT NULL,
  `title` text NOT NULL,
  `summary` text NOT NULL,
  `required_decision` text,
  `allowed_actions_json` text NOT NULL,
  `source_refs_json` text NOT NULL,
  `input_sha256` text NOT NULL,
  `status` text NOT NULL,
  `resolution` text,
  `version` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `resolved_at` integer,
  CONSTRAINT `company_attention_issue_kind_check` CHECK (`issue_kind` IN ('implementation_error', 'missing_prerequisite', 'capability_gap', 'reviewer_finding', 'graph_dependency_error', 'runtime_transient', 'permission_required', 'scope_change', 'acceptance_change', 'budget_change', 'external_side_effect', 'permanent_organization_change', 'unresolved_material_risk')),
  CONSTRAINT `company_attention_risk_check` CHECK (`risk` IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT `company_attention_materiality_check` CHECK (`materiality` IN ('internal', 'permission', 'scope', 'acceptance', 'budget', 'external_side_effect', 'organization', 'unresolved_risk')),
  CONSTRAINT `company_attention_route_check` CHECK (`route` IN ('worker_rework', 'graph_supervisor', 'recruitment_resolver', 'graph_mutation_policy', 'automatic_recovery', 'approval_gate', 'project_dri', 'user', 'company_governance')),
  CONSTRAINT `company_attention_material_check` CHECK (`material` IN (0, 1)),
  CONSTRAINT `company_attention_interrupts_user_check` CHECK (`interrupts_user` IN (0, 1)),
  CONSTRAINT `company_attention_status_check` CHECK (`status` IN ('open', 'resolved', 'superseded')),
  CONSTRAINT `company_attention_version_check` CHECK (`version` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_attention_project_idempotency_idx` ON `company_attention` (`project_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `company_attention_project_status_idx` ON `company_attention` (`project_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `company_project_action` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `attention_id` text REFERENCES `company_attention`(`id`) ON DELETE SET NULL,
  `action` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `payload_json` text NOT NULL,
  `payload_sha256` text NOT NULL,
  `expected_revision` integer,
  `status` text NOT NULL,
  `result_json` text,
  `error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `claimed_at` integer,
  `finished_at` integer,
  CONSTRAINT `company_project_action_action_check` CHECK (`action` IN ('pause_work', 'resume_work', 'stop_work', 'retry', 'resolve_blocker', 'adjust_brief')),
  CONSTRAINT `company_project_action_revision_check` CHECK (`expected_revision` IS NULL OR `expected_revision` >= 0),
  CONSTRAINT `company_project_action_status_check` CHECK (`status` IN ('requested', 'claimed', 'applied', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_project_action_project_idempotency_idx` ON `company_project_action` (`project_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `company_project_action_project_status_idx` ON `company_project_action` (`project_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `company_project_action_attention_idx` ON `company_project_action` (`attention_id`);
