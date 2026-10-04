ALTER TABLE "email_templates" ADD COLUMN IF NOT EXISTS "layout" text DEFAULT 'brand' NOT NULL;--> statement-breakpoint
-- instantly-service registers these four and sends every one of them to the agency inbox, not to a customer.
UPDATE "email_templates" SET "layout" = 'none' WHERE "name" IN ('campaign-error', 'reply-escalation', 'reply-handover', 'positive-reply-forward');
