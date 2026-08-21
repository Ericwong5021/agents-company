ALTER TABLE `company_agent` ADD `small_model` text NOT NULL DEFAULT 'lite';
UPDATE `company_agent` SET `model` = 'standard' WHERE `model` IS NULL OR trim(`model`) = '';
