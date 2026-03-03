DROP INDEX IF EXISTS "idx_email_events_app_type";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_email_templates_app_name";--> statement-breakpoint
ALTER TABLE "email_events" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "email_events" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_events_org_type" ON "email_events" USING btree ("org_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_templates_name" ON "email_templates" USING btree ("name");--> statement-breakpoint
ALTER TABLE "email_events" DROP COLUMN IF EXISTS "app_id";--> statement-breakpoint
ALTER TABLE "email_templates" DROP COLUMN IF EXISTS "app_id";