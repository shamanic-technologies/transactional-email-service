ALTER TABLE "email_templates" ADD COLUMN IF NOT EXISTS "stream" text DEFAULT 'broadcast' NOT NULL;--> statement-breakpoint
-- instantly-service's answer-it-yourself email: the customer replies to it straight to their prospect (Reply-To), so it is person-to-person mail.
UPDATE "email_templates" SET "stream" = 'transactional' WHERE "name" = 'positive-reply-answer-request';
