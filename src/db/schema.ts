import { pgTable, uuid, text, timestamp, uniqueIndex, index, jsonb, integer } from "drizzle-orm/pg-core";

export const emailEvents = pgTable(
  "email_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    dedupKey: text("dedup_key"),
    // Null when the send had no acting user (machine caller — e.g. a Stripe
    // webhook observed outside our product). Never a placeholder id.
    userId: text("user_id"),
    orgId: text("org_id").notNull(),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata"),
    campaignId: text("campaign_id"),
    brandIds: text("brand_ids").array(),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    audienceId: text("audience_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_email_events_dedup").on(table.dedupKey),
    index("idx_email_events_org_type").on(table.orgId, table.eventType),
    index("idx_email_events_recipient").on(table.recipientEmail),
    index("idx_email_events_brand_ids").using("gin", table.brandIds),
  ]
);

export type EmailEvent = typeof emailEvents.$inferSelect;
export type NewEmailEvent = typeof emailEvents.$inferInsert;

export const emailTemplates = pgTable(
  "email_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    htmlBody: text("html_body").notNull(),
    textBody: text("text_body").notNull().default(""),
    fromAddress: text("from_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_email_templates_name").on(table.name),
  ]
);

export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type NewEmailTemplate = typeof emailTemplates.$inferInsert;

/**
 * Platform-level (staff-owned) mailing lists. Deliberately NOT org-scoped: a
 * list such as `investors` belongs to the platform, not to a customer
 * organisation, and its members are bare email addresses with no source
 * resource. An organisation id still travels on the request, but only as the
 * sending identity used downstream (Postmark key + from address resolution).
 */
export const mailingLists = pgTable(
  "mailing_lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_mailing_lists_slug").on(table.slug)]
);

export type MailingList = typeof mailingLists.$inferSelect;

/**
 * A subscriber is one bare email address on one list. Opt-out state is NOT
 * stored here: Postmark's broadcast stream owns the suppression list, and both
 * the read path and the send reconcile against it — per address, so the cost
 * tracks the list rather than total send volume — so the service can never
 * display a suppressed address as subscribed, nor mail one.
 */
export const mailingListSubscribers = pgTable(
  "mailing_list_subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .notNull()
      .references(() => mailingLists.id, { onDelete: "cascade" }),
    // Always stored lower-cased; the parser normalises before insert.
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_mailing_list_subscribers_list_email").on(table.listId, table.email),
  ]
);

export type MailingListSubscriber = typeof mailingListSubscribers.$inferSelect;

/**
 * One written update broadcast to a list. Stores the body exactly as sent
 * (rendered HTML) alongside the markdown the author typed, plus the outcome of
 * every recipient send — a partial failure is recorded as `partial`, never as a
 * clean success.
 */
export const mailingListUpdates = pgTable(
  "mailing_list_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .notNull()
      .references(() => mailingLists.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    /** Markdown as authored by staff. */
    bodyMarkdown: text("body_markdown").notNull(),
    /** Rendered HTML, byte-identical to what recipients received. */
    htmlBody: text("html_body").notNull(),
    /** "sent" — every recipient succeeded. "partial" — at least one failed. */
    status: text("status").notNull(),
    /** Recipients the send actually reached. */
    recipientCount: integer("recipient_count").notNull(),
    /** [{ email, reason }] for every recipient whose send failed. */
    failures: jsonb("failures").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_mailing_list_updates_list").on(table.listId, table.sentAt)]
);

export type MailingListUpdate = typeof mailingListUpdates.$inferSelect;
