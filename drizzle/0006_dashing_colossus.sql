DROP INDEX IF EXISTS "idx_email_events_app_type";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_email_templates_app_name";--> statement-breakpoint
UPDATE "email_events" SET "user_id" = 'legacy' WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "email_events" SET "org_id" = 'legacy' WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "email_events" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "email_events" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_events_org_type" ON "email_events" USING btree ("org_id","event_type");--> statement-breakpoint
DELETE FROM "email_templates" WHERE "id" NOT IN (SELECT DISTINCT ON ("name") "id" FROM "email_templates" ORDER BY "name", "updated_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_templates_name" ON "email_templates" USING btree ("name");--> statement-breakpoint
ALTER TABLE "email_events" DROP COLUMN IF EXISTS "app_id";--> statement-breakpoint
ALTER TABLE "email_templates" DROP COLUMN IF EXISTS "app_id";