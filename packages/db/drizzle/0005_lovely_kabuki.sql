CREATE TABLE `pending_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`channel` text NOT NULL,
	`tool_name` text NOT NULL,
	`args` text NOT NULL,
	`origins` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `pending_actions_channel_idx` ON `pending_actions` (`channel`);--> statement-breakpoint
CREATE INDEX `pending_actions_task_idx` ON `pending_actions` (`task_id`);--> statement-breakpoint
CREATE INDEX `pending_actions_status_idx` ON `pending_actions` (`status`);--> statement-breakpoint
ALTER TABLE `agent_configs` ADD `security_mode` text DEFAULT 'ask';