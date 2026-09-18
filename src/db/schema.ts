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
    /**
     * The address this update went out from, as sent. Stated per send by the
     * caller and defaulted to the investor-update sender, so a later read can
     * tell a newsletter leaving a dedicated subdomain from an investor update
     * leaving the apex address.
     */
    fromAddress: text("from_address").notNull(),
    /**
     * How the body was authored: "markdown" was written as markdown and
     * rendered here, "html" was a finished document sent as the author wrote it.
     * Recorded because the two are indistinguishable from `html_body` alone,
     * and a later reader asking "did we render this or did a person?" has no
     * other way to know.
     */
    bodyKind: text("body_kind").notNull(),
    /**
     * Markdown as authored by staff — null for an update authored as HTML,
     * where there never was any markdown. Storing the HTML here instead would
     * record a markdown source nobody wrote.
     */
    bodyMarkdown: text("body_markdown"),
    /** Body as sent, byte-identical to what recipients received. */
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

/**
 * A written update being released to a list over several days at a stated pace.
 *
 * The synchronous send (`POST /mailing-lists/:slug/updates`) puts the whole
 * list out inside the request that asked for it. That is right for a list of
 * one and impossible for a list of thirty thousand: the caller's HTTP client
 * abandons the response long before the send finishes, nothing records which
 * addresses were reached, and there is no way to slow it down or stop it. A
 * release is the same update with those four properties added.
 *
 * The row holds everything a send needs, because the thing that will perform
 * the send has no inbound request to read it from. An identity does not survive
 * an async boundary, so the acting organisation, the acting user and the run
 * this release is tracked under are captured here when the release is created
 * and replayed by the worker days later. The same goes for the sender, the
 * body, and the workflow-attribution headers.
 */
export const mailingListReleases = pgTable(
  "mailing_list_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .notNull()
      .references(() => mailingLists.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    /** The address every message in this release leaves from, as stated at creation. */
    fromAddress: text("from_address").notNull(),
    /** "markdown" was rendered by this service; "html" is the document staff authored. */
    bodyKind: text("body_kind").notNull(),
    /** Markdown as authored, and null for a release whose body was authored as HTML. */
    bodyMarkdown: text("body_markdown"),
    /** The HTML every recipient receives, byte-for-byte. */
    htmlBody: text("html_body").notNull(),
    /** The plain-text part every recipient receives. */
    textBody: text("text_body").notNull(),
    /**
     * Content fingerprint over (subject, htmlBody, textBody, fromAddress). A
     * second request stating the same update for the same list returns the
     * release the first one created rather than starting a parallel one over
     * the same addresses.
     */
    dedupKey: text("dedup_key").notNull(),
    /** How many messages this release may send per UTC calendar day. */
    dailyLimit: integer("daily_limit").notNull(),
    /**
     * "running" — the worker is releasing it. "paused" — staff stopped it and
     * may resume. "cancelled" — staff ended it; it never resumes. "halted" —
     * the release stopped itself because the provider's delivery outcomes went
     * bad, and staff were told. "completed" — every recipient is accounted for.
     */
    status: text("status").notNull(),
    /** Why a halted release halted, in the words a staff alert repeated. Null otherwise. */
    haltedReason: text("halted_reason"),
    /** How many addresses the list held when the release was created. */
    recipientCount: integer("recipient_count").notNull(),
    // The identity a send is performed under, captured at creation because the
    // worker has no request to read it from. Never defaulted, never guessed: a
    // release missing any of these halts rather than mailing from something
    // nobody chose.
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    /** The run every message in this release is tracked under, and the key its delivery outcomes are read by. */
    runId: uuid("run_id").notNull(),
    campaignId: text("campaign_id"),
    brandIds: text("brand_ids").array(),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    audienceId: text("audience_id"),
    /** When the delivery-outcome health of this release was last read from the provider. */
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_mailing_list_releases_list").on(table.listId, table.createdAt),
    index("idx_mailing_list_releases_status").on(table.status),
    index("idx_mailing_list_releases_dedup").on(table.listId, table.dedupKey),
  ]
);

export type MailingListRelease = typeof mailingListReleases.$inferSelect;

/**
 * One address on one release, and the ledger that makes never-mailing-anyone
 * twice structural rather than careful.
 *
 * The rows are written once, when the release is created, as a snapshot of the
 * list at that moment. From then on the only thing that changes is a row's
 * status, and the unique index on (release, email) means no second row for the
 * same person can exist however many times a release is issued or a worker
 * restarts. Progress — reached, remaining, failed, today's allowance used — is
 * read from here rather than counted in memory, so it survives a redeploy.
 *
 * "pending" has not been picked up. "sending" is claimed by a worker and its
 * outcome is not yet known. "sent" reached the gateway. "failed" did not, with
 * the reason. "skipped_opted_out" was suppressed by the provider at the moment
 * its slice was sent, which is why the check belongs here and not once at the
 * start: somebody who unsubscribes on day 1 is skipped on day 5.
 */
export const mailingListReleaseRecipients = pgTable(
  "mailing_list_release_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => mailingListReleases.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    status: text("status").notNull().default("pending"),
    /** The provider's reason for a failure, or its suppression reason for a skip. */
    reason: text("reason"),
    /** When a worker claimed this row. Used to notice a claim a crash left behind. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** When this row reached a terminal status. Today's usage is counted from it. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_mailing_list_release_recipients_unique").on(table.releaseId, table.email),
    index("idx_mailing_list_release_recipients_claim").on(table.releaseId, table.status),
    index("idx_mailing_list_release_recipients_settled").on(table.releaseId, table.settledAt),
  ]
);

export type MailingListReleaseRecipient = typeof mailingListReleaseRecipients.$inferSelect;
