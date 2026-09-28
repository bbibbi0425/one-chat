CREATE TABLE `limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`token_hash` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_token` ON `members` (`token_hash`);--> statement-breakpoint
CREATE INDEX `members_room` ON `members` (`room_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`room_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`iv` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_identity` ON `messages` (`room_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_nonce` ON `messages` (`room_id`,`iv`);--> statement-breakpoint
CREATE INDEX `messages_cursor` ON `messages` (`room_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `messages_rate` ON `messages` (`room_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rooms_expiry` ON `rooms` (`expires_at`);