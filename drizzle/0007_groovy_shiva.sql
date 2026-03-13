ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "campaign_id" text;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "brand_id" text;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "workflow_name" text;