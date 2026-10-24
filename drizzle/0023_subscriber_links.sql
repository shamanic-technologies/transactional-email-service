CREATE TABLE "mailing_list_subscriber_links" (
	"link_id" text PRIMARY KEY NOT NULL,
	"list_id" uuid NOT NULL,
	"subscriber_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailing_list_subscriber_links" ADD CONSTRAINT "mailing_list_subscriber_links_list_id_mailing_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."mailing_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailing_list_subscriber_links" ADD CONSTRAINT "mailing_list_subscriber_links_subscriber_id_mailing_list_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."mailing_list_subscribers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_mailing_list_subscriber_links_subscriber" ON "mailing_list_subscriber_links" USING btree ("subscriber_id");