ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "subject" text;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "html_body" text;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "text_body" text;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "from_address" text;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "sent_at" timestamp with time zone;--> statement-breakpoint
UPDATE "email_events" SET "sent_at" = date_trunc('milliseconds', "created_at") WHERE "status" = 'sent' AND "sent_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_events_sent_at" ON "email_events" USING btree ("sent_at","id");
