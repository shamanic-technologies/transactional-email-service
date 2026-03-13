ALTER TABLE "email_templates" ADD COLUMN IF NOT EXISTS "from_address" text;--> statement-breakpoint
ALTER TABLE "email_templates" ADD COLUMN IF NOT EXISTS "message_stream" text;