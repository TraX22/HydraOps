CREATE TABLE `tool_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text,
	`tool_name` text NOT NULL,
	`source` text DEFAULT 'native' NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_usage_agent_idx` ON `tool_usage` (`agent_id`);--> statement-breakpoint
CREATE INDEX `tool_usage_tool_idx` ON `tool_usage` (`tool_name`);--> statement-breakpoint
CREATE INDEX `tool_usage_created_idx` ON `tool_usage` (`created_at`);