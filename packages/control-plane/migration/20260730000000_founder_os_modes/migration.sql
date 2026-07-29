ALTER TABLE `company` ADD `founder_twin_mode` text DEFAULT 'off' NOT NULL CHECK (`founder_twin_mode` IN ('off', 'shadow', 'advisor', 'green-delegated', 'yellow-delegated'));--> statement-breakpoint
ALTER TABLE `company` ADD `company_commons_mode` text DEFAULT 'off' NOT NULL CHECK (`company_commons_mode` IN ('off', 'ingest-only', 'reading', 'belief-loop'));
