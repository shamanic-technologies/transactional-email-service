-- Every update sent before an authored HTML body was possible was markdown this
-- service rendered, so that is what those rows record.
ALTER TABLE "mailing_list_updates" ADD COLUMN IF NOT EXISTS "body_kind" text;--> statement-breakpoint
UPDATE "mailing_list_updates" SET "body_kind" = 'markdown' WHERE "body_kind" IS NULL;--> statement-breakpoint
ALTER TABLE "mailing_list_updates" ALTER COLUMN "body_kind" SET NOT NULL;--> statement-breakpoint
-- An update authored as HTML has no markdown source, and recording the HTML as
-- one would claim a person wrote markdown they never wrote.
ALTER TABLE "mailing_list_updates" ALTER COLUMN "body_markdown" DROP NOT NULL;
