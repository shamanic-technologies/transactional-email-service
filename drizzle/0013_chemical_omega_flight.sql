CREATE TABLE IF NOT EXISTS "mailing_list_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailing_list_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"body_markdown" text NOT NULL,
	"html_body" text NOT NULL,
	"status" text NOT NULL,
	"recipient_count" integer NOT NULL,
	"failures" jsonb NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailing_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailing_list_subscribers" ADD CONSTRAINT "mailing_list_subscribers_list_id_mailing_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."mailing_lists"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mailing_list_updates" ADD CONSTRAINT "mailing_list_updates_list_id_mailing_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."mailing_lists"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mailing_list_subscribers_list_email" ON "mailing_list_subscribers" USING btree ("list_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mailing_list_updates_list" ON "mailing_list_updates" USING btree ("list_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mailing_lists_slug" ON "mailing_lists" USING btree ("slug");