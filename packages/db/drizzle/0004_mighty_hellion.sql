CREATE TABLE `security_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text,
	`type` text NOT NULL,
	`tool_name` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_events_task_idx` ON `security_events` (`task_id`);--> statement-breakpoint
CREATE INDEX `security_events_created_idx` ON `security_events` (`created_at`);