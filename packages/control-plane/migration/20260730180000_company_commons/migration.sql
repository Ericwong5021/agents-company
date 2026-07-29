PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE `company_artifact_new` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text REFERENCES `company_project`(`id`) ON DELETE CASCADE,
  `company_id` text,
  `scope_type` text DEFAULT 'project' NOT NULL,
  `private_owner_id` text,
  `work_item_id` text REFERENCES `company_work_item`(`id`) ON DELETE SET NULL,
  `kind` text NOT NULL,
  `title` text NOT NULL,
  `path` text,
  `content` text,
  `evidence_json` text NOT NULL,
  `created_by_agent_id` text,
  `created_at` integer NOT NULL,
  CONSTRAINT `company_artifact_scope_check` CHECK (
    (`scope_type` = 'project' AND `project_id` IS NOT NULL AND `private_owner_id` IS NULL)
    OR (`scope_type` = 'company' AND `company_id` IS NOT NULL AND `project_id` IS NULL AND `private_owner_id` IS NULL)
    OR (`scope_type` = 'private' AND `company_id` IS NOT NULL AND `project_id` IS NULL AND `private_owner_id` IS NOT NULL)
  )
);
--> statement-breakpoint
INSERT INTO `company_artifact_new` (
  `id`, `project_id`, `company_id`, `scope_type`, `private_owner_id`, `work_item_id`,
  `kind`, `title`, `path`, `content`, `evidence_json`, `created_by_agent_id`, `created_at`
)
SELECT
  `id`, `project_id`, NULL, 'project', NULL, `work_item_id`,
  `kind`, `title`, `path`, `content`, `evidence_json`, `created_by_agent_id`, `created_at`
FROM `company_artifact`;
--> statement-breakpoint
DROP TABLE `company_artifact`;
--> statement-breakpoint
ALTER TABLE `company_artifact_new` RENAME TO `company_artifact`;
--> statement-breakpoint
CREATE INDEX `company_artifact_project_idx` ON `company_artifact` (`project_id`);
--> statement-breakpoint
CREATE INDEX `company_artifact_company_scope_idx` ON `company_artifact` (`company_id`,`scope_type`);
--> statement-breakpoint
CREATE INDEX `company_artifact_private_owner_idx` ON `company_artifact` (`private_owner_id`);
--> statement-breakpoint
CREATE INDEX `company_artifact_work_item_idx` ON `company_artifact` (`work_item_id`);
--> statement-breakpoint
CREATE TABLE `company_commons_source` (
  `id` text PRIMARY KEY NOT NULL,
  `artifact_id` text NOT NULL REFERENCES `company_artifact`(`id`) ON DELETE CASCADE,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `project_id` text REFERENCES `company_project`(`id`) ON DELETE SET NULL,
  `private_owner_id` text,
  `source_type` text NOT NULL,
  `title` text NOT NULL,
  `author` text,
  `origin` text,
  `published_at` integer,
  `language` text,
  `tags_json` text NOT NULL,
  `privacy_scope` text NOT NULL,
  `ingestion_status` text NOT NULL,
  `transcript_status` text NOT NULL,
  `content_hash` text,
  `normalized_content_hash` text,
  `duplicate_of_source_id` text REFERENCES `company_commons_source`(`id`) ON DELETE SET NULL,
  `deduplication_kind` text,
  `metadata_json` text NOT NULL,
  `adapter_id` text,
  `adapter_version` text,
  `error_code` text,
  `error_message` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `company_commons_source_type_check` CHECK (`source_type` IN ('text','markdown','url','conversation_export','pdf','image','podcast','video')),
  CONSTRAINT `company_commons_privacy_scope_check` CHECK (`privacy_scope` IN ('company','project','private')),
  CONSTRAINT `company_commons_ingestion_status_check` CHECK (`ingestion_status` IN ('queued','processing','ready','failed','blocked','unsupported')),
  CONSTRAINT `company_commons_transcript_status_check` CHECK (`transcript_status` IN ('not_applicable','queued','processing','ready','failed','blocked','unsupported')),
  CONSTRAINT `company_commons_deduplication_kind_check` CHECK (`deduplication_kind` IS NULL OR `deduplication_kind` IN ('exact','normalized')),
  CONSTRAINT `company_commons_scope_check` CHECK (
    (`privacy_scope` = 'company' AND `project_id` IS NULL AND `private_owner_id` IS NULL)
    OR (`privacy_scope` = 'project' AND `project_id` IS NOT NULL AND `private_owner_id` IS NULL)
    OR (`privacy_scope` = 'private' AND `project_id` IS NULL AND `private_owner_id` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_commons_source_artifact_idx` ON `company_commons_source` (`artifact_id`);
--> statement-breakpoint
CREATE INDEX `company_commons_source_company_status_idx` ON `company_commons_source` (`company_id`,`ingestion_status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `company_commons_source_project_idx` ON `company_commons_source` (`project_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `company_commons_source_private_idx` ON `company_commons_source` (`private_owner_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `company_commons_source_hash_idx` ON `company_commons_source` (`company_id`,`content_hash`);
--> statement-breakpoint
CREATE INDEX `company_commons_source_normalized_hash_idx` ON `company_commons_source` (`company_id`,`normalized_content_hash`);
--> statement-breakpoint
CREATE TABLE `company_commons_chunk` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL REFERENCES `company_commons_source`(`id`) ON DELETE CASCADE,
  `ordinal` integer NOT NULL,
  `body` text NOT NULL,
  `content_hash` text NOT NULL,
  `start_offset` integer NOT NULL,
  `end_offset` integer NOT NULL,
  `source_span_json` text NOT NULL,
  `trust_class` text DEFAULT 'untrusted_source' NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `company_commons_chunk_span_check` CHECK (`start_offset` >= 0 AND `end_offset` >= `start_offset`),
  CONSTRAINT `company_commons_chunk_trust_check` CHECK (`trust_class` = 'untrusted_source')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_commons_chunk_source_ordinal_idx` ON `company_commons_chunk` (`source_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `company_commons_chunk_source_span_idx` ON `company_commons_chunk` (`source_id`,`start_offset`,`end_offset`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `company_commons_chunk_fts` USING fts5(
  body,
  content='company_commons_chunk',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);
--> statement-breakpoint
CREATE TRIGGER `company_commons_chunk_ai` AFTER INSERT ON `company_commons_chunk` BEGIN
  INSERT INTO `company_commons_chunk_fts`(rowid, body) VALUES (NEW.rowid, NEW.body);
END;
--> statement-breakpoint
CREATE TRIGGER `company_commons_chunk_ad` AFTER DELETE ON `company_commons_chunk` BEGIN
  INSERT INTO `company_commons_chunk_fts`(`company_commons_chunk_fts`, rowid, body) VALUES('delete', OLD.rowid, OLD.body);
END;
--> statement-breakpoint
CREATE TRIGGER `company_commons_chunk_au` AFTER UPDATE ON `company_commons_chunk` BEGIN
  INSERT INTO `company_commons_chunk_fts`(`company_commons_chunk_fts`, rowid, body) VALUES('delete', OLD.rowid, OLD.body);
  INSERT INTO `company_commons_chunk_fts`(rowid, body) VALUES (NEW.rowid, NEW.body);
END;
