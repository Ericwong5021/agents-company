ALTER TABLE `governance_asset` ADD `approved_at` integer;
--> statement-breakpoint
UPDATE `governance_asset`
SET `approved_at` = `created_at`
WHERE `approved_by` IS NOT NULL AND `approved_at` IS NULL;
--> statement-breakpoint
ALTER TABLE `founder_twin_snapshot` ADD `active_principle_ids_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `founder_twin_snapshot` ADD `active_heuristic_ids_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `founder_twin_snapshot` ADD `decision_case_ids_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `founder_twin_snapshot` ADD `taste_example_ids_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `founder_twin_snapshot` ADD `rubric_ids_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
UPDATE `founder_twin_snapshot`
SET
  `active_principle_ids_json` = COALESCE((
    SELECT json_group_array(json_extract(`reference`.`value`, '$.assetId'))
    FROM json_each(`founder_twin_snapshot`.`asset_refs_json`) AS `reference`
    JOIN `governance_asset`
      ON `governance_asset`.`id` = json_extract(`reference`.`value`, '$.assetId')
      AND `governance_asset`.`version` = json_extract(`reference`.`value`, '$.version')
    WHERE `governance_asset`.`type` IN ('constitution', 'principle', 'boundary')
  ), '[]'),
  `active_heuristic_ids_json` = COALESCE((
    SELECT json_group_array(json_extract(`reference`.`value`, '$.assetId'))
    FROM json_each(`founder_twin_snapshot`.`asset_refs_json`) AS `reference`
    JOIN `governance_asset`
      ON `governance_asset`.`id` = json_extract(`reference`.`value`, '$.assetId')
      AND `governance_asset`.`version` = json_extract(`reference`.`value`, '$.version')
    WHERE `governance_asset`.`type` = 'heuristic'
  ), '[]'),
  `decision_case_ids_json` = COALESCE((
    SELECT json_group_array(json_extract(`reference`.`value`, '$.assetId'))
    FROM json_each(`founder_twin_snapshot`.`asset_refs_json`) AS `reference`
    JOIN `governance_asset`
      ON `governance_asset`.`id` = json_extract(`reference`.`value`, '$.assetId')
      AND `governance_asset`.`version` = json_extract(`reference`.`value`, '$.version')
    WHERE `governance_asset`.`type` = 'decision_case'
  ), '[]'),
  `taste_example_ids_json` = COALESCE((
    SELECT json_group_array(json_extract(`reference`.`value`, '$.assetId'))
    FROM json_each(`founder_twin_snapshot`.`asset_refs_json`) AS `reference`
    JOIN `governance_asset`
      ON `governance_asset`.`id` = json_extract(`reference`.`value`, '$.assetId')
      AND `governance_asset`.`version` = json_extract(`reference`.`value`, '$.version')
    WHERE `governance_asset`.`type` IN ('taste_reference', 'taste_anti_reference')
  ), '[]'),
  `rubric_ids_json` = COALESCE((
    SELECT json_group_array(json_extract(`reference`.`value`, '$.assetId'))
    FROM json_each(`founder_twin_snapshot`.`asset_refs_json`) AS `reference`
    JOIN `governance_asset`
      ON `governance_asset`.`id` = json_extract(`reference`.`value`, '$.assetId')
      AND `governance_asset`.`version` = json_extract(`reference`.`value`, '$.version')
    WHERE `governance_asset`.`type` = 'rubric'
  ), '[]');
