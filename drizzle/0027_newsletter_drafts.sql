CREATE TABLE IF NOT EXISTS "newsletter_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"body_kind" text NOT NULL,
	"body_markdown" text,
	"html_body" text NOT NULL,
	"text_body" text NOT NULL,
	"dedup_key" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"brand_ids" text[],
	"drafted_at" timestamp with time zone NOT NULL,
	"drafted_run_id" uuid NOT NULL,
	"drafted_declared_at" timestamp with time zone,
	"validated_at" timestamp with time zone,
	"validated_by_user_id" text,
	"validated_run_id" uuid,
	"validated_declared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailing_list_releases" ADD COLUMN IF NOT EXISTS "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "newsletter_drafts" ADD CONSTRAINT "newsletter_drafts_list_id_mailing_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."mailing_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_newsletter_drafts_list_dedup" ON "newsletter_drafts" USING btree ("list_id","dedup_key");--> statement-breakpoint
ALTER TABLE "mailing_list_releases" ADD CONSTRAINT "mailing_list_releases_draft_id_newsletter_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."newsletter_drafts"("id") ON DELETE set null ON UPDATE no action;