CREATE TABLE IF NOT EXISTS "mailing_list_release_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"claimed_at" timestamp with time zone,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailing_list_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"from_address" text NOT NULL,
	"body_kind" text NOT NULL,
	"body_markdown" text,
	"html_body" text NOT NULL,
	"text_body" text NOT NULL,
	"dedup_key" text NOT NULL,
	"daily_limit" integer NOT NULL,
	"status" text NOT NULL,
	"halted_reason" text,
	"recipient_count" integer NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"campaign_id" text,
	"brand_ids" text[],
	"workflow_slug" text,
	"feature_slug" text,
	"audience_id" text,
	"last_health_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailing_list_release_recipients" ADD CONSTRAINT "mailing_list_release_recipients_release_id_mailing_list_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."mailing_list_releases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailing_list_releases" ADD CONSTRAINT "mailing_list_releases_list_id_mailing_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."mailing_lists"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mailing_list_release_recipients_unique" ON "mailing_list_release_recipients" USING btree ("release_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mailing_list_release_recipients_claim" ON "mailing_list_release_recipients" USING btree ("release_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mailing_list_release_recipients_settled" ON "mailing_list_release_recipients" USING btree ("release_id","settled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mailing_list_releases_list" ON "mailing_list_releases" USING btree ("list_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mailing_list_releases_status" ON "mailing_list_releases" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mailing_list_releases_dedup" ON "mailing_list_releases" USING btree ("list_id","dedup_key");