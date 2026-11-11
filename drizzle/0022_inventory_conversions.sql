CREATE TABLE IF NOT EXISTS `inventory_conversions` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `requestKey` varchar(36) NOT NULL,
  `sourceType` varchar(20) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'PENDING',
  `version` int NOT NULL DEFAULT 0,
  `payload` json NOT NULL,
  `previewHash` varchar(64) NOT NULL,
  `createdBy` int NOT NULL,
  `createdByName` varchar(255),
  `executedBy` int,
  `executedByName` varchar(255),
  `executedAt` timestamp NULL,
  `cancelledBy` int,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `conversion_pending_idx` (`sourceType`,`status`),
  CONSTRAINT `conversion_request_key_unique` UNIQUE (`requestKey`),
  CONSTRAINT `inventory_conversions_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`),
  CONSTRAINT `inventory_conversions_executedBy_users_id_fk` FOREIGN KEY (`executedBy`) REFERENCES `users`(`id`),
  CONSTRAINT `inventory_conversions_cancelledBy_users_id_fk` FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `inventory_conversion_items` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `conversionId` int NOT NULL,
  `sourceType` varchar(20) NOT NULL,
  `sourceId` int NOT NULL,
  `targetType` varchar(20) NOT NULL,
  `targetId` int,
  `quantity` int NOT NULL,
  `sourceSnapshot` json NOT NULL,
  `targetSnapshot` json NOT NULL,
  UNIQUE `conversion_request_source_unique` (`conversionId`,`sourceId`),
  INDEX `conversion_source_idx` (`sourceType`,`sourceId`),
  INDEX `conversion_target_idx` (`targetType`,`targetId`),
  CONSTRAINT `conversion_item_request_fk` FOREIGN KEY (`conversionId`) REFERENCES `inventory_conversions`(`id`)
) ENGINE=InnoDB;
