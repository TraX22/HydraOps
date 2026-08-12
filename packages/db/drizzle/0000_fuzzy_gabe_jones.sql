CREATE TABLE `agent_configs` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`worker_type` text DEFAULT 'coder',
	`graphic_engine` text DEFAULT 'auto',
	`graphic_format` text DEFAULT 'png',
	`last_heartbeat` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cron_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`cron_expression` text NOT NULL,
	`assigned_agent` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`version` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	`producer` text NOT NULL,
	`subject_entity` text NOT NULL,
	`subject_id` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE INDEX `events_subject_idx` ON `events` (`subject_entity`,`subject_id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`published_at` integer,
	`last_error` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `processed_events` (
	`consumer_name` text NOT NULL,
	`event_id` text NOT NULL,
	`processed_at` integer NOT NULL,
	PRIMARY KEY(`consumer_name`, `event_id`)
);
--> statement-breakpoint
CREATE TABLE `system_configs` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt` text NOT NULL,
	`channel` text DEFAULT 'main' NOT NULL,
	`status` text NOT NULL,
	`assigned_agent` text,
	`result_ref` text,
	`result_meta` text,
	`workflow_chain` text,
	`workflow_step` integer DEFAULT 0,
	`is_read` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_status` (
	`worker_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`last_heartbeat` integer NOT NULL,
	`updated_at` integer NOT NULL
);
