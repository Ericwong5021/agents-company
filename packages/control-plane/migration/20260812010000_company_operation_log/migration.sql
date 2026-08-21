CREATE TABLE `company_operation_log` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `company`(`id`) ON DELETE CASCADE,
  `category` text NOT NULL,
  `severity` text NOT NULL,
  `importance` text NOT NULL,
  `event_type` text NOT NULL,
  `source_kind` text NOT NULL,
  `source_id` text NOT NULL,
  `root_need_id` text,
  `project_id` text,
  `thread_id` text,
  `agent_id` text,
  `run_id` text,
  `work_item_id` text,
  `occurred_at` integer NOT NULL,
  CONSTRAINT `company_operation_category_check` CHECK (`category` IN ('governance','work','runtime','quality','delivery','organization','system')),
  CONSTRAINT `company_operation_severity_check` CHECK (`severity` IN ('info','warning','error')),
  CONSTRAINT `company_operation_importance_check` CHECK (`importance` IN ('primary','normal','diagnostic'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_operation_source_idx` ON `company_operation_log` (`company_id`,`source_kind`,`source_id`);
--> statement-breakpoint
CREATE INDEX `company_operation_company_time_idx` ON `company_operation_log` (`company_id`,`occurred_at`,`id`);
--> statement-breakpoint
CREATE INDEX `company_operation_company_category_time_idx` ON `company_operation_log` (`company_id`,`category`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `company_operation_company_severity_time_idx` ON `company_operation_log` (`company_id`,`severity`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `company_operation_company_importance_time_idx` ON `company_operation_log` (`company_id`,`importance`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `company_operation_company_project_time_idx` ON `company_operation_log` (`company_id`,`project_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `company_operation_company_agent_time_idx` ON `company_operation_log` (`company_id`,`agent_id`,`occurred_at`);
--> statement-breakpoint
CREATE TRIGGER `company_operation_immutable_update` BEFORE UPDATE ON `company_operation_log`
BEGIN
  SELECT RAISE(ABORT, 'company_operation_log is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_immutable_delete` BEFORE DELETE ON `company_operation_log`
WHEN EXISTS (SELECT 1 FROM `company` WHERE `id` = OLD.`company_id`)
BEGIN
  SELECT RAISE(ABORT, 'company_operation_log is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_project_event_insert` AFTER INSERT ON `company_project_event`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (
    `id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,
    `root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`
  )
  SELECT
    'cop_' || lower(hex(randomblob(16))), project.`company_id`,
    CASE
      WHEN NEW.`type` LIKE 'validation%' OR NEW.`type` LIKE 'acceptance%' OR NEW.`type` LIKE '%review%' OR NEW.`type` LIKE '%rework%' THEN 'quality'
      WHEN NEW.`type` LIKE 'delivery%' OR NEW.`type` LIKE 'artifact%' OR NEW.`type` LIKE 'outcome_signal%' THEN 'delivery'
      WHEN NEW.`type` LIKE 'project_assignment%' OR NEW.`type` LIKE '%agent_selected%' OR NEW.`type` LIKE '%reassigned%' THEN 'organization'
      WHEN NEW.`type` LIKE 'approval%' OR NEW.`type` LIKE 'attention%' OR NEW.`type` LIKE 'project_action%' OR NEW.`type` LIKE 'board_%' THEN 'governance'
      WHEN NEW.`type` LIKE 'project%' OR NEW.`type` LIKE 'plan%' OR NEW.`type` LIKE 'work_%' OR NEW.`type` LIKE 'dispatch%' THEN 'work'
      ELSE 'system'
    END,
    CASE
      WHEN NEW.`type` LIKE '%failed%' OR (
        json_valid(NEW.`data_json`) AND (
          lower(COALESCE(json_extract(NEW.`data_json`, '$.status'), '')) = 'failed'
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.verdict'), '')) = 'failed'
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.result'), '')) = 'failed'
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.outcome'), '')) = 'failed'
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.to'), '')) = 'failed'
        )
      ) THEN 'error'
      WHEN NEW.`type` LIKE '%rejected%' OR NEW.`type` LIKE '%aborted%' OR NEW.`type` LIKE '%stopped%' OR NEW.`type` LIKE '%paused%' OR (
        json_valid(NEW.`data_json`) AND (
          lower(COALESCE(json_extract(NEW.`data_json`, '$.status'), '')) IN ('blocked','stopped','rejected')
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.verdict'), '')) = 'inconclusive'
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.result'), '')) = 'inconclusive'
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.outcome'), '')) IN ('blocked','ask')
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.to'), '')) IN ('blocked','paused','rejected')
        )
      ) THEN 'warning'
      ELSE 'info'
    END,
    CASE
      WHEN NEW.`type` LIKE '%failed%' OR NEW.`type` LIKE '%rejected%' OR NEW.`type` LIKE '%aborted%' OR NEW.`type` LIKE '%stopped%' OR NEW.`type` LIKE '%paused%' OR NEW.`type` LIKE '%recovered%' OR NEW.`type` LIKE '%retry%' OR NEW.`type` LIKE '%rework%' OR NEW.`type` LIKE 'delivery%' OR NEW.`type` LIKE 'artifact%' OR NEW.`type` LIKE 'outcome_signal%' OR NEW.`type` LIKE 'approval%' OR NEW.`type` LIKE 'attention%' OR NEW.`type` LIKE '%status_changed%' OR (
        json_valid(NEW.`data_json`) AND (
          lower(COALESCE(json_extract(NEW.`data_json`, '$.status'), '')) IN ('failed','blocked','stopped','rejected')
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.verdict'), '')) IN ('failed','inconclusive')
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.result'), '')) IN ('failed','inconclusive')
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.outcome'), '')) IN ('failed','blocked','ask')
          OR lower(COALESCE(json_extract(NEW.`data_json`, '$.to'), '')) IN ('failed','blocked','paused','rejected')
        )
      ) THEN 'primary'
      WHEN NEW.`type` LIKE 'dispatch.claim%' OR NEW.`type` LIKE '%anchor.checked' THEN 'diagnostic'
      WHEN NEW.`type` LIKE 'project%' OR NEW.`type` LIKE 'plan%' OR NEW.`type` LIKE 'work_%' OR NEW.`type` LIKE 'dispatch%' OR NEW.`type` LIKE 'validation%' OR NEW.`type` LIKE 'acceptance%' OR NEW.`type` LIKE 'delivery%' OR NEW.`type` LIKE 'artifact%' OR NEW.`type` LIKE 'outcome_signal%' OR NEW.`type` LIKE 'project_assignment%' OR NEW.`type` LIKE 'approval%' OR NEW.`type` LIKE 'attention%' OR NEW.`type` LIKE 'project_action%' OR NEW.`type` LIKE 'board_%' THEN 'normal'
      ELSE 'diagnostic'
    END,
    NEW.`type`,'project_event',NEW.`id`,project.`root_need_id`,project.`id`,project.`source_thread_id`,NEW.`actor_id`,NULL,
    CASE WHEN json_valid(NEW.`data_json`) THEN json_extract(NEW.`data_json`, '$.work_item_id') ELSE NULL END,
    NEW.`created_at`
  FROM `company_project` project
  WHERE project.`id` = NEW.`project_id`
    AND project.`company_id` IS NOT NULL
    AND NOT (
      NEW.`type` = 'artifact.created'
      AND json_valid(NEW.`data_json`)
      AND EXISTS (
        SELECT 1 FROM `company_operation_log` operation
        WHERE operation.`source_kind` = 'artifact'
          AND operation.`source_id` = json_extract(NEW.`data_json`, '$.artifact_id')
      )
    );
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_run_event_insert` AFTER INSERT ON `agent_run_event`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (
    `id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,
    `root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`
  )
  SELECT
    'cop_' || lower(hex(randomblob(16))),COALESCE(project.`company_id`,agent.`company_id`),
    CASE
      WHEN NEW.`type` LIKE 'lifecycle.%' OR NEW.`type` LIKE 'runtime.%' OR NEW.`type` LIKE 'agent_run.%' OR NEW.`type` IN ('usage.recorded','local_command.finished') THEN 'runtime'
      ELSE 'system'
    END,
    CASE
      WHEN NEW.`type` IN ('lifecycle.failed','runtime.failed') OR (
        NEW.`type` = 'local_command.finished' AND json_valid(NEW.`payload_json`) AND COALESCE(json_extract(NEW.`payload_json`, '$.exitCode'), 0) != 0
      ) THEN 'error'
      WHEN NEW.`type` IN ('lifecycle.awaiting_recovery','lifecycle.stopped','lifecycle.interrupting','agent_run.recovery_deferred') THEN 'warning'
      ELSE 'info'
    END,
    CASE
      WHEN NEW.`type` IN ('lifecycle.failed','lifecycle.completed','lifecycle.awaiting_recovery','lifecycle.stopped','runtime.failed','runtime.completed','agent_run.recovery_deferred','local_command.finished') THEN 'primary'
      WHEN NEW.`type` LIKE 'lifecycle.%' THEN 'normal'
      ELSE 'diagnostic'
    END,
    NEW.`type`,'agent_run_event',NEW.`id`,project.`root_need_id`,run.`company_project_id`,run.`conversation_thread_id`,
    run.`agent_id`,run.`id`,run.`work_item_id`,NEW.`time_created`
  FROM `agent_run` run
  LEFT JOIN `company_project` project ON project.`id` = run.`company_project_id`
  LEFT JOIN `company_agent` agent ON agent.`id` = run.`agent_id`
  WHERE run.`id` = NEW.`agent_run_id` AND COALESCE(project.`company_id`,agent.`company_id`) IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_audit_event_insert` AFTER INSERT ON `audit_event`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (
    `id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,
    `root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`
  )
  SELECT
    'cop_' || lower(hex(randomblob(16))),
    COALESCE(need.`company_id`,subject_project.`company_id`,run_project.`company_id`,actor.`company_id`,target.`company_id`),
    'system',CASE WHEN NEW.`granted` = 0 THEN 'warning' ELSE 'info' END,
    CASE WHEN NEW.`granted` = 0 OR NEW.`kind` IN ('admission','escalation') THEN 'primary' ELSE 'diagnostic' END,
    'audit.' || NEW.`kind` || '.' || NEW.`action`,'audit_event',NEW.`id`,NEW.`root_need_id`,
    COALESCE(subject_project.`id`,run.`company_project_id`),
    COALESCE(subject_project.`source_thread_id`,run.`conversation_thread_id`),
    COALESCE(NEW.`actor_agent_id`,NEW.`target_agent_id`),run.`id`,run.`work_item_id`,NEW.`time_created`
  FROM (SELECT 1) seed
  LEFT JOIN `root_need` need ON need.`id` = NEW.`root_need_id`
  LEFT JOIN `company_project` subject_project ON NEW.`subject_type` IN ('project','company_project') AND subject_project.`id` = NEW.`subject_id`
  LEFT JOIN `agent_run` run ON NEW.`subject_type` IN ('run','agent_run') AND run.`id` = NEW.`subject_id`
  LEFT JOIN `company_project` run_project ON run_project.`id` = run.`company_project_id`
  LEFT JOIN `company_agent` actor ON actor.`id` = NEW.`actor_agent_id`
  LEFT JOIN `company_agent` target ON target.`id` = NEW.`target_agent_id`
  WHERE COALESCE(need.`company_id`,subject_project.`company_id`,run_project.`company_id`,actor.`company_id`,target.`company_id`) IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_channel_signal_insert` AFTER INSERT ON `channel_message` WHEN NEW.`signal_type` IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (
    `id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,
    `root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`
  )
  SELECT
    'cop_' || lower(hex(randomblob(16))),channel.`company_id`,
    CASE
      WHEN NEW.`signal_type` IN ('decision','approval','intervention','risk') THEN 'governance'
      WHEN NEW.`signal_type` = 'delivery' THEN 'delivery'
      ELSE 'work'
    END,
    CASE WHEN NEW.`signal_type` = 'risk' THEN 'warning' ELSE 'info' END,'primary',
    'signal.' || NEW.`signal_type`,'channel_signal',NEW.`id`,NEW.`root_need_id`,
    CASE
      WHEN channel.`kind` = 'project' THEN channel.`scope_id`
      ELSE (SELECT project.`id` FROM `company_project` project WHERE project.`root_need_id` = NEW.`root_need_id` ORDER BY project.`created_at` DESC LIMIT 1)
    END,
    NEW.`source_thread_id`,CASE WHEN NEW.`author_kind` = 'agent' THEN NEW.`author_id` ELSE NULL END,NULL,NULL,NEW.`time_created`
  FROM `channel` channel WHERE channel.`id` = NEW.`channel_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_approval_insert` AFTER INSERT ON `company_approval_gate`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (
    `id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,
    `root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`
  )
  SELECT
    'cop_' || lower(hex(randomblob(16))),COALESCE(NEW.`company_id`,project.`company_id`),'governance','info','primary',
    'approval.pending','approval_gate',NEW.`id` || ':pending:' || NEW.`requested_at`,
    project.`root_need_id`,NEW.`project_id`,project.`source_thread_id`,NEW.`requested_by_agent_id`,NULL,NEW.`work_item_id`,NEW.`requested_at`
  FROM (SELECT 1) seed
  LEFT JOIN `company_project` project ON project.`id` = NEW.`project_id`
  WHERE COALESCE(NEW.`company_id`,project.`company_id`) IS NOT NULL;

  INSERT OR IGNORE INTO `company_operation_log` (
    `id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,
    `root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`
  )
  SELECT
    'cop_' || lower(hex(randomblob(16))),COALESCE(NEW.`company_id`,project.`company_id`),'governance',
    CASE WHEN NEW.`status` IN ('rejected','cancelled','expired') THEN 'warning' ELSE 'info' END,'primary',
    'approval.' || NEW.`status`,'approval_gate',NEW.`id` || ':' || NEW.`status` || ':' || COALESCE(NEW.`decided_at`,NEW.`requested_at`),
    project.`root_need_id`,NEW.`project_id`,project.`source_thread_id`,NEW.`requested_by_agent_id`,NULL,NEW.`work_item_id`,
    COALESCE(NEW.`decided_at`,NEW.`requested_at`)
  FROM (SELECT 1) seed
  LEFT JOIN `company_project` project ON project.`id` = NEW.`project_id`
  WHERE NEW.`status` != 'pending' AND COALESCE(NEW.`company_id`,project.`company_id`) IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_approval_status_update` AFTER UPDATE OF `status` ON `company_approval_gate` WHEN OLD.`status` IS NOT NEW.`status`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (
    `id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,
    `root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`
  )
  SELECT
    'cop_' || lower(hex(randomblob(16))),COALESCE(NEW.`company_id`,project.`company_id`),'governance',
    CASE WHEN NEW.`status` IN ('rejected','cancelled','expired') THEN 'warning' ELSE 'info' END,'primary',
    'approval.' || NEW.`status`,'approval_gate',NEW.`id` || ':' || NEW.`status` || ':' || COALESCE(NEW.`decided_at`,NEW.`requested_at`),
    project.`root_need_id`,NEW.`project_id`,project.`source_thread_id`,NEW.`requested_by_agent_id`,NULL,NEW.`work_item_id`,
    COALESCE(NEW.`decided_at`,NEW.`requested_at`)
  FROM (SELECT 1) seed
  LEFT JOIN `company_project` project ON project.`id` = NEW.`project_id`
  WHERE COALESCE(NEW.`company_id`,project.`company_id`) IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_artifact_insert` AFTER INSERT ON `company_artifact`
WHEN NEW.`scope_type` != 'private' AND NOT EXISTS (
  SELECT 1 FROM `company_project_event` event
  WHERE event.`type` = 'artifact.created'
    AND json_valid(event.`data_json`)
    AND json_extract(event.`data_json`, '$.artifact_id') = NEW.`id`
)
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (
    `id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,
    `root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`
  )
  SELECT
    'cop_' || lower(hex(randomblob(16))),COALESCE(NEW.`company_id`,project.`company_id`),'delivery','info','primary',
    'artifact.created','artifact',NEW.`id`,project.`root_need_id`,NEW.`project_id`,project.`source_thread_id`,
    NEW.`created_by_agent_id`,NULL,NEW.`work_item_id`,NEW.`created_at`
  FROM (SELECT 1) seed
  LEFT JOIN `company_project` project ON project.`id` = NEW.`project_id`
  WHERE COALESCE(NEW.`company_id`,project.`company_id`) IS NOT NULL;
END;
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT
  'cop_' || lower(hex(randomblob(16))),project.`company_id`,
  CASE
    WHEN event.`type` LIKE 'validation%' OR event.`type` LIKE 'acceptance%' OR event.`type` LIKE '%review%' OR event.`type` LIKE '%rework%' THEN 'quality'
    WHEN event.`type` LIKE 'delivery%' OR event.`type` LIKE 'artifact%' OR event.`type` LIKE 'outcome_signal%' THEN 'delivery'
    WHEN event.`type` LIKE 'project_assignment%' OR event.`type` LIKE '%agent_selected%' OR event.`type` LIKE '%reassigned%' THEN 'organization'
    WHEN event.`type` LIKE 'approval%' OR event.`type` LIKE 'attention%' OR event.`type` LIKE 'project_action%' OR event.`type` LIKE 'board_%' THEN 'governance'
    WHEN event.`type` LIKE 'project%' OR event.`type` LIKE 'plan%' OR event.`type` LIKE 'work_%' OR event.`type` LIKE 'dispatch%' THEN 'work'
    ELSE 'system'
  END,
  CASE
    WHEN event.`type` LIKE '%failed%' OR (
      json_valid(event.`data_json`) AND (
        lower(COALESCE(json_extract(event.`data_json`, '$.status'), '')) = 'failed'
        OR lower(COALESCE(json_extract(event.`data_json`, '$.verdict'), '')) = 'failed'
        OR lower(COALESCE(json_extract(event.`data_json`, '$.result'), '')) = 'failed'
        OR lower(COALESCE(json_extract(event.`data_json`, '$.outcome'), '')) = 'failed'
        OR lower(COALESCE(json_extract(event.`data_json`, '$.to'), '')) = 'failed'
      )
    ) THEN 'error'
    WHEN event.`type` LIKE '%rejected%' OR event.`type` LIKE '%aborted%' OR event.`type` LIKE '%stopped%' OR event.`type` LIKE '%paused%' OR (
      json_valid(event.`data_json`) AND (
        lower(COALESCE(json_extract(event.`data_json`, '$.status'), '')) IN ('blocked','stopped','rejected')
        OR lower(COALESCE(json_extract(event.`data_json`, '$.verdict'), '')) = 'inconclusive'
        OR lower(COALESCE(json_extract(event.`data_json`, '$.result'), '')) = 'inconclusive'
        OR lower(COALESCE(json_extract(event.`data_json`, '$.outcome'), '')) IN ('blocked','ask')
        OR lower(COALESCE(json_extract(event.`data_json`, '$.to'), '')) IN ('blocked','paused','rejected')
      )
    ) THEN 'warning'
    ELSE 'info'
  END,
  CASE
    WHEN event.`type` LIKE '%failed%' OR event.`type` LIKE '%rejected%' OR event.`type` LIKE '%aborted%' OR event.`type` LIKE '%stopped%' OR event.`type` LIKE '%paused%' OR event.`type` LIKE '%recovered%' OR event.`type` LIKE '%retry%' OR event.`type` LIKE '%rework%' OR event.`type` LIKE 'delivery%' OR event.`type` LIKE 'artifact%' OR event.`type` LIKE 'outcome_signal%' OR event.`type` LIKE 'approval%' OR event.`type` LIKE 'attention%' OR event.`type` LIKE '%status_changed%' OR (
      json_valid(event.`data_json`) AND (
        lower(COALESCE(json_extract(event.`data_json`, '$.status'), '')) IN ('failed','blocked','stopped','rejected')
        OR lower(COALESCE(json_extract(event.`data_json`, '$.verdict'), '')) IN ('failed','inconclusive')
        OR lower(COALESCE(json_extract(event.`data_json`, '$.result'), '')) IN ('failed','inconclusive')
        OR lower(COALESCE(json_extract(event.`data_json`, '$.outcome'), '')) IN ('failed','blocked','ask')
        OR lower(COALESCE(json_extract(event.`data_json`, '$.to'), '')) IN ('failed','blocked','paused','rejected')
      )
    ) THEN 'primary'
    WHEN event.`type` LIKE 'dispatch.claim%' OR event.`type` LIKE '%anchor.checked' THEN 'diagnostic'
    WHEN event.`type` LIKE 'project%' OR event.`type` LIKE 'plan%' OR event.`type` LIKE 'work_%' OR event.`type` LIKE 'dispatch%' OR event.`type` LIKE 'validation%' OR event.`type` LIKE 'acceptance%' OR event.`type` LIKE 'delivery%' OR event.`type` LIKE 'artifact%' OR event.`type` LIKE 'outcome_signal%' OR event.`type` LIKE 'project_assignment%' OR event.`type` LIKE 'approval%' OR event.`type` LIKE 'attention%' OR event.`type` LIKE 'project_action%' OR event.`type` LIKE 'board_%' THEN 'normal'
    ELSE 'diagnostic'
  END,
  event.`type`,'project_event',event.`id`,project.`root_need_id`,project.`id`,project.`source_thread_id`,event.`actor_id`,NULL,
  CASE WHEN json_valid(event.`data_json`) THEN json_extract(event.`data_json`, '$.work_item_id') ELSE NULL END,event.`created_at`
FROM `company_project_event` event
JOIN `company_project` project ON project.`id` = event.`project_id`
WHERE project.`company_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT
  'cop_' || lower(hex(randomblob(16))),COALESCE(project.`company_id`,agent.`company_id`),
  CASE
    WHEN event.`type` LIKE 'lifecycle.%' OR event.`type` LIKE 'runtime.%' OR event.`type` LIKE 'agent_run.%' OR event.`type` IN ('usage.recorded','local_command.finished') THEN 'runtime'
    ELSE 'system'
  END,
  CASE
    WHEN event.`type` IN ('lifecycle.failed','runtime.failed') OR (
      event.`type` = 'local_command.finished' AND json_valid(event.`payload_json`) AND COALESCE(json_extract(event.`payload_json`, '$.exitCode'), 0) != 0
    ) THEN 'error'
    WHEN event.`type` IN ('lifecycle.awaiting_recovery','lifecycle.stopped','lifecycle.interrupting','agent_run.recovery_deferred') THEN 'warning'
    ELSE 'info'
  END,
  CASE
    WHEN event.`type` IN ('lifecycle.failed','lifecycle.completed','lifecycle.awaiting_recovery','lifecycle.stopped','runtime.failed','runtime.completed','agent_run.recovery_deferred','local_command.finished') THEN 'primary'
    WHEN event.`type` LIKE 'lifecycle.%' THEN 'normal'
    ELSE 'diagnostic'
  END,
  event.`type`,'agent_run_event',event.`id`,project.`root_need_id`,run.`company_project_id`,run.`conversation_thread_id`,run.`agent_id`,run.`id`,run.`work_item_id`,event.`time_created`
FROM `agent_run_event` event
JOIN `agent_run` run ON run.`id` = event.`agent_run_id`
LEFT JOIN `company_project` project ON project.`id` = run.`company_project_id`
LEFT JOIN `company_agent` agent ON agent.`id` = run.`agent_id`
WHERE COALESCE(project.`company_id`,agent.`company_id`) IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT
  'cop_' || lower(hex(randomblob(16))),channel.`company_id`,
  CASE WHEN message.`signal_type` IN ('decision','approval','intervention','risk') THEN 'governance' WHEN message.`signal_type` = 'delivery' THEN 'delivery' ELSE 'work' END,
  CASE WHEN message.`signal_type` = 'risk' THEN 'warning' ELSE 'info' END,'primary','signal.' || message.`signal_type`,
  'channel_signal',message.`id`,message.`root_need_id`,CASE WHEN channel.`kind` = 'project' THEN channel.`scope_id` ELSE NULL END,
  message.`source_thread_id`,CASE WHEN message.`author_kind` = 'agent' THEN message.`author_id` ELSE NULL END,NULL,NULL,message.`time_created`
FROM `channel_message` message JOIN `channel` channel ON channel.`id` = message.`channel_id`
WHERE message.`signal_type` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT
  'cop_' || lower(hex(randomblob(16))),COALESCE(gate.`company_id`,project.`company_id`),'governance','info','primary','approval.pending',
  'approval_gate',gate.`id` || ':pending:' || gate.`requested_at`,project.`root_need_id`,gate.`project_id`,
  project.`source_thread_id`,gate.`requested_by_agent_id`,NULL,gate.`work_item_id`,gate.`requested_at`
FROM `company_approval_gate` gate
LEFT JOIN `company_project` project ON project.`id` = gate.`project_id`
WHERE COALESCE(gate.`company_id`,project.`company_id`) IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT
  'cop_' || lower(hex(randomblob(16))),COALESCE(gate.`company_id`,project.`company_id`),'governance',
  CASE WHEN gate.`status` IN ('rejected','cancelled','expired') THEN 'warning' ELSE 'info' END,'primary','approval.' || gate.`status`,
  'approval_gate',gate.`id` || ':' || gate.`status` || ':' || COALESCE(gate.`decided_at`,gate.`requested_at`),project.`root_need_id`,gate.`project_id`,
  project.`source_thread_id`,gate.`requested_by_agent_id`,NULL,gate.`work_item_id`,COALESCE(gate.`decided_at`,gate.`requested_at`)
FROM `company_approval_gate` gate
LEFT JOIN `company_project` project ON project.`id` = gate.`project_id`
WHERE gate.`status` != 'pending' AND COALESCE(gate.`company_id`,project.`company_id`) IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT
  'cop_' || lower(hex(randomblob(16))),COALESCE(artifact.`company_id`,project.`company_id`),'delivery','info','primary','artifact.created','artifact',artifact.`id`,
  project.`root_need_id`,artifact.`project_id`,project.`source_thread_id`,artifact.`created_by_agent_id`,NULL,artifact.`work_item_id`,artifact.`created_at`
FROM `company_artifact` artifact
LEFT JOIN `company_project` project ON project.`id` = artifact.`project_id`
WHERE artifact.`scope_type` != 'private'
  AND COALESCE(artifact.`company_id`,project.`company_id`) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `company_project_event` event
    WHERE event.`type` = 'artifact.created'
      AND json_valid(event.`data_json`)
      AND json_extract(event.`data_json`, '$.artifact_id') = artifact.`id`
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT
  'cop_' || lower(hex(randomblob(16))),
  COALESCE(need.`company_id`,subject_project.`company_id`,run_project.`company_id`,actor.`company_id`,target.`company_id`),
  'system',CASE WHEN audit.`granted` = 0 THEN 'warning' ELSE 'info' END,
  CASE WHEN audit.`granted` = 0 OR audit.`kind` IN ('admission','escalation') THEN 'primary' ELSE 'diagnostic' END,
  'audit.' || audit.`kind` || '.' || audit.`action`,'audit_event',audit.`id`,audit.`root_need_id`,COALESCE(subject_project.`id`,run.`company_project_id`),
  COALESCE(subject_project.`source_thread_id`,run.`conversation_thread_id`),COALESCE(audit.`actor_agent_id`,audit.`target_agent_id`),run.`id`,run.`work_item_id`,audit.`time_created`
FROM `audit_event` audit
LEFT JOIN `root_need` need ON need.`id` = audit.`root_need_id`
LEFT JOIN `company_project` subject_project ON audit.`subject_type` IN ('project','company_project') AND subject_project.`id` = audit.`subject_id`
LEFT JOIN `agent_run` run ON audit.`subject_type` IN ('run','agent_run') AND run.`id` = audit.`subject_id`
LEFT JOIN `company_project` run_project ON run_project.`id` = run.`company_project_id`
LEFT JOIN `company_agent` actor ON actor.`id` = audit.`actor_agent_id`
LEFT JOIN `company_agent` target ON target.`id` = audit.`target_agent_id`
WHERE COALESCE(need.`company_id`,subject_project.`company_id`,run_project.`company_id`,actor.`company_id`,target.`company_id`) IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `company_operation_team_selection_insert` AFTER INSERT ON `company_team_selection`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
  SELECT 'cop_' || lower(hex(randomblob(16))),COALESCE(NEW.`company_id`,project.`company_id`),'organization',
    CASE WHEN NEW.`decision` = 'rejected' THEN 'warning' ELSE 'info' END,'normal','team_selection.' || NEW.`decision`,
    'team_selection',NEW.`id`,project.`root_need_id`,NEW.`project_id`,project.`source_thread_id`,NEW.`agent_id`,NULL,need.`work_item_id`,NEW.`time_created`
  FROM `company_project` project
  LEFT JOIN `company_capability_need` need ON need.`id` = NEW.`capability_need_id`
  WHERE project.`id` = NEW.`project_id` AND COALESCE(NEW.`company_id`,project.`company_id`) IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_team_selection_release` AFTER UPDATE OF `time_released` ON `company_team_selection`
WHEN OLD.`time_released` IS NULL AND NEW.`time_released` IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
  SELECT 'cop_' || lower(hex(randomblob(16))),COALESCE(NEW.`company_id`,project.`company_id`),'organization','info','normal','team_selection.released',
    'team_selection',NEW.`id` || ':released:' || NEW.`time_released`,project.`root_need_id`,NEW.`project_id`,project.`source_thread_id`,NEW.`agent_id`,NULL,need.`work_item_id`,NEW.`time_released`
  FROM `company_project` project
  LEFT JOIN `company_capability_need` need ON need.`id` = NEW.`capability_need_id`
  WHERE project.`id` = NEW.`project_id` AND COALESCE(NEW.`company_id`,project.`company_id`) IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_agent_performance_insert` AFTER INSERT ON `company_agent_performance`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
  SELECT 'cop_' || lower(hex(randomblob(16))),NEW.`company_id`,'organization',
    CASE WHEN NEW.`outcome` IN ('failure','failed','rejected') THEN 'warning' ELSE 'info' END,'normal','agent_performance.' || NEW.`outcome`,
    'agent_performance',NEW.`id`,project.`root_need_id`,NEW.`project_id`,project.`source_thread_id`,NEW.`agent_id`,NULL,NULL,NEW.`time_created`
  FROM `company_project` project WHERE project.`id` = NEW.`project_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_agent_performance_update` AFTER UPDATE OF `outcome`,`quality_score`,`reliability_score`,`cost_score`,`speed_score` ON `company_agent_performance`
WHEN OLD.`outcome` IS NOT NEW.`outcome`
  OR OLD.`quality_score` IS NOT NEW.`quality_score`
  OR OLD.`reliability_score` IS NOT NEW.`reliability_score`
  OR OLD.`cost_score` IS NOT NEW.`cost_score`
  OR OLD.`speed_score` IS NOT NEW.`speed_score`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
  SELECT 'cop_' || lower(hex(randomblob(16))),NEW.`company_id`,'organization',
    CASE WHEN NEW.`outcome` IN ('failure','failed','rejected') THEN 'warning' ELSE 'info' END,'normal','agent_performance.' || NEW.`outcome`,
    'agent_performance',NEW.`id` || ':' || NEW.`outcome` || ':' || NEW.`time_updated`,project.`root_need_id`,NEW.`project_id`,project.`source_thread_id`,NEW.`agent_id`,NULL,NULL,NEW.`time_updated`
  FROM `company_project` project WHERE project.`id` = NEW.`project_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_employment_review_insert` AFTER INSERT ON `company_employment_review`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
  VALUES ('cop_' || lower(hex(randomblob(16))),NEW.`company_id`,'organization','info','primary','employment_review.' || NEW.`status`,
    'employment_review',NEW.`id`,NULL,NULL,NULL,NEW.`agent_id`,NULL,NULL,COALESCE(NEW.`time_decided`,NEW.`time_created`));
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_department_insert` AFTER INSERT ON `company_department`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
  VALUES ('cop_' || lower(hex(randomblob(16))),NEW.`company_id`,'organization','info','normal','department.' || NEW.`status`,
    'department',NEW.`id` || ':' || NEW.`status` || ':' || NEW.`time_updated`,NULL,NULL,NULL,NULL,NULL,NULL,NEW.`time_updated`);
END;
--> statement-breakpoint
CREATE TRIGGER `company_operation_department_status_update` AFTER UPDATE OF `status` ON `company_department` WHEN OLD.`status` IS NOT NEW.`status`
BEGIN
  INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
  VALUES ('cop_' || lower(hex(randomblob(16))),NEW.`company_id`,'organization','info','normal','department.' || NEW.`status`,
    'department',NEW.`id` || ':' || NEW.`status` || ':' || NEW.`time_updated`,NULL,NULL,NULL,NULL,NULL,NULL,NEW.`time_updated`);
END;
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT 'cop_' || lower(hex(randomblob(16))),COALESCE(selection.`company_id`,project.`company_id`),'organization',
  CASE WHEN selection.`decision` = 'rejected' THEN 'warning' ELSE 'info' END,'normal','team_selection.' || selection.`decision`,
  'team_selection',selection.`id`,project.`root_need_id`,selection.`project_id`,project.`source_thread_id`,selection.`agent_id`,NULL,need.`work_item_id`,selection.`time_created`
FROM `company_team_selection` selection
JOIN `company_project` project ON project.`id` = selection.`project_id`
LEFT JOIN `company_capability_need` need ON need.`id` = selection.`capability_need_id`
WHERE COALESCE(selection.`company_id`,project.`company_id`) IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT 'cop_' || lower(hex(randomblob(16))),performance.`company_id`,'organization',
  CASE WHEN performance.`outcome` IN ('failure','failed','rejected') THEN 'warning' ELSE 'info' END,'normal','agent_performance.' || performance.`outcome`,
  'agent_performance',performance.`id`,project.`root_need_id`,performance.`project_id`,project.`source_thread_id`,performance.`agent_id`,NULL,NULL,performance.`time_created`
FROM `company_agent_performance` performance JOIN `company_project` project ON project.`id` = performance.`project_id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT 'cop_' || lower(hex(randomblob(16))),review.`company_id`,'organization','info','primary','employment_review.' || review.`status`,
  'employment_review',review.`id`,NULL,NULL,NULL,review.`agent_id`,NULL,NULL,COALESCE(review.`time_decided`,review.`time_created`)
FROM `company_employment_review` review;
--> statement-breakpoint
INSERT OR IGNORE INTO `company_operation_log` (`id`,`company_id`,`category`,`severity`,`importance`,`event_type`,`source_kind`,`source_id`,`root_need_id`,`project_id`,`thread_id`,`agent_id`,`run_id`,`work_item_id`,`occurred_at`)
SELECT 'cop_' || lower(hex(randomblob(16))),department.`company_id`,'organization','info','normal','department.' || department.`status`,
  'department',department.`id` || ':' || department.`status` || ':' || department.`time_updated`,NULL,NULL,NULL,NULL,NULL,NULL,department.`time_updated`
FROM `company_department` department;
