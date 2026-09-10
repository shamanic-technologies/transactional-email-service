-- Every update sent before this column existed left the one fixed investor-update
-- sender, so that is what those rows record. New sends state their own.
ALTER TABLE "mailing_list_updates" ADD COLUMN IF NOT EXISTS "from_address" text;--> statement-breakpoint
UPDATE "mailing_list_updates" SET "from_address" = 'kevin@distribute.you' WHERE "from_address" IS NULL;--> statement-breakpoint
ALTER TABLE "mailing_list_updates" ALTER COLUMN "from_address" SET NOT NULL;
