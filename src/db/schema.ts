import { pgTable, uuid, text, timestamp, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";

export const emailEvents = pgTable(
  "email_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    dedupKey: text("dedup_key"),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata"),
    campaignId: text("campaign_id"),
    brandId: text("brand_id"),
    workflowName: text("workflow_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_email_events_dedup").on(table.dedupKey),
    index("idx_email_events_org_type").on(table.orgId, table.eventType),
    index("idx_email_events_recipient").on(table.recipientEmail),
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
