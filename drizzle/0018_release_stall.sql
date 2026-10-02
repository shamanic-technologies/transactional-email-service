ALTER TABLE "mailing_list_releases" ADD COLUMN IF NOT EXISTS "stalled_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailing_list_releases" ADD COLUMN IF NOT EXISTS "stall_ticks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailing_list_releases" ADD COLUMN IF NOT EXISTS "stall_reason" text;--> statement-breakpoint
ALTER TABLE "mailing_list_releases" ADD COLUMN IF NOT EXISTS "stall_alerted_at" timestamp with time zone;