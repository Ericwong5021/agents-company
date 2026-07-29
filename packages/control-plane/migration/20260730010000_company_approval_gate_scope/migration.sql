ALTER TABLE `company_approval_gate` ADD COLUMN `work_item_id` text REFERENCES `company_work_item`(`id`) ON DELETE SET NULL;
ALTER TABLE `company_approval_gate` ADD COLUMN `resource_scope_json` text NOT NULL DEFAULT '[]';
CREATE INDEX `company_approval_gate_work_item_idx` ON `company_approval_gate` (`work_item_id`, `status`);
