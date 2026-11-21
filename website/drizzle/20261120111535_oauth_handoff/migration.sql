CREATE TABLE `oauth_handoff` (
	`state_hash` text PRIMARY KEY,
	`code` text,
	`error` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_handoff_expires_at_idx` ON `oauth_handoff` (`expires_at`);