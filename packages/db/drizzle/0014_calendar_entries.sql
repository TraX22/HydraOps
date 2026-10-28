CREATE TABLE `calendar_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`at` integer NOT NULL,
	`timezone` text NOT NULL,
	`date` text NOT NULL,
	`time` text,
	`repeat` text DEFAULT 'none' NOT NULL,
	`repeat_until` text,
	`occurrences_left` integer,
	`agent_id` text,
	`prompt` text,
	`attachments` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`approved_at` integer,
	`created_by_task` text,
	`origins` text,
	`last_run_at` integer,
	`last_task_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `calendar_due_idx` ON `calendar_entries` (`status`,`at`);--> statement-breakpoint
CREATE INDEX `calendar_owner_idx` ON `calendar_entries` (`owner`,`status`);