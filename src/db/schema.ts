import { pgTable, uuid, text, timestamp, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";

export const emailEvents = pgTable(
  "email_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: text("app_id").notNull(),
    eventType: text("event_type").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    dedupKey: text("dedup_key"),
    userId: text("user_id"),
    orgId: text("org_id"),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_email_events_dedup").on(table.dedupKey),
    index("idx_email_events_app_type").on(table.appId, table.eventType),
    index("idx_email_events_recipient").on(table.recipientEmail),
  ]
);

export type EmailEvent = typeof emailEvents.$inferSelect;
export type NewEmailEvent = typeof emailEvents.$inferInsert;

export const emailTemplates = pgTable(
  "email_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: text("app_id").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    htmlBody: text("html_body").notNull(),
    textBody: text("text_body").notNull().default(""),
    fromAddress: text("from_address"),
    messageStream: text("message_stream"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_email_templates_app_name").on(table.appId, table.name),
  ]
);

export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type NewEmailTemplate = typeof emailTemplates.$inferInsert;
