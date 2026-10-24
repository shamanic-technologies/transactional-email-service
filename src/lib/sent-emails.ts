import { and, asc, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailEvents, type EmailEvent } from "../db/schema.js";
import { getTemplate, type TemplateResult } from "../templates/index.js";
import { signRendered } from "./sign-rendered.js";
import { ADMIN_NOTIFICATION_EVENTS } from "./staff-events.js";
import { PLATFORM_STAFF_ALERTS } from "./platform-staff-alerts.js";

/**
 * TX-EMAIL-IN-UNIBOX-1024: every transactional email we send a client also
 * appears in that client's Unibox thread (owner 2026-10-24: « ça n'annule pas
 * le transactionnel. Mais le transactionnel envoyé doit aussi être ajouté à
 * l'Unibox »). The send itself is untouched; this service only RECORDS the
 * message it put on the wire, on the same row and in the same write that marks
 * it sent, and serves the record for crm-service to read (crm READS siblings,
 * it is never pushed to). One sent row = one Unibox message; a failed send
 * writes nothing here and is never served.
 */
export function sentMessageColumns(template: TemplateResult) {
  return {
    status: "sent",
    subject: template.subject,
    htmlBody: template.htmlBody,
    textBody: template.textBody,
    fromAddress: template.from ?? null,
    sentAt: new Date(),
  } as const;
}

export type MessageSource = "stored" | "replayed" | "unavailable";

export interface SentEmail {
  id: string;
  eventType: string;
  recipientEmail: string;
  orgId: string | null;
  brandIds: string[] | null;
  from: string | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  sentAt: string;
  messageSource: MessageSource;
}

// Opaque to the caller: "<sentAt ISO>|<id>", the feed's sort key.
export function encodeCursor(sentAt: Date, id: string): string {
  return Buffer.from(`${sentAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { sentAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const sentAt = new Date(iso ?? "");
  if (!id || Number.isNaN(sentAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { sentAt, id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rows from February 2026 carry "legacy" or a Clerk "org_…" id from before
// internal org ids existed: neither names an org a reader can look up, so the
// feed says "no org" rather than serve a placeholder.
export function internalOrgId(orgId: string | null): string | null {
  return orgId !== null && UUID.test(orgId) ? orgId : null;
}

const STAFF_ROUTED = [...ADMIN_NOTIFICATION_EVENTS, ...Object.keys(PLATFORM_STAFF_ALERTS)];

/**
 * A send made before messages were stored (migration 0024) is re-rendered from
 * its CURRENT template with the variables stored on the row: close to what was
 * sent, not guaranteed byte-equal, and labelled so. A template that no longer
 * exists cannot be replayed: the row is still served (the send happened) with
 * no subject or body. A render error is logged and never fails the page.
 */
type TemplateFn = Awaited<ReturnType<typeof getTemplate>>;

async function replay(row: EmailEvent, templates: Map<string, Promise<TemplateFn>>): Promise<Pick<SentEmail, "from" | "subject" | "textBody" | "htmlBody" | "messageSource">> {
  try {
    if (!templates.has(row.eventType)) templates.set(row.eventType, getTemplate(row.eventType));
    const templateFn = await templates.get(row.eventType)!;
    const rendered = signRendered(row.eventType, templateFn((row.metadata ?? {}) as Record<string, unknown>));
    return { from: rendered.from ?? null, subject: rendered.subject, textBody: rendered.textBody, htmlBody: rendered.htmlBody, messageSource: "replayed" };
  } catch (err: any) {
    console.warn(`[sent-emails] cannot replay ${row.eventType} ${row.id}: ${err?.message}`);
    return { from: null, subject: null, textBody: null, htmlBody: null, messageSource: "unavailable" };
  }
}

/**
 * Sent client-facing emails, oldest first, after `cursor`. Staff-routed alerts
 * (mail to staff ABOUT a client) are never served: every row here went to its
 * recipient as a message from us.
 */
export async function listSentEmails(opts: { after: { sentAt: Date; id: string } | null; limit: number }): Promise<{ emails: SentEmail[]; nextCursor: string | null }> {
  const conditions = [
    eq(emailEvents.status, "sent"),
    isNotNull(emailEvents.sentAt),
    sql`${emailEvents.eventType} NOT IN (${sql.join(STAFF_ROUTED.map((e) => sql`${e}`), sql`, `)})`,
  ];
  if (opts.after) {
    conditions.push(
      or(gt(emailEvents.sentAt, opts.after.sentAt), and(eq(emailEvents.sentAt, opts.after.sentAt), gt(emailEvents.id, opts.after.id)))!
    );
  }
  const rows = await db
    .select()
    .from(emailEvents)
    .where(and(...conditions))
    .orderBy(asc(emailEvents.sentAt), asc(emailEvents.id))
    .limit(opts.limit);

  const templates = new Map<string, Promise<TemplateFn>>();
  const emails: SentEmail[] = [];
  for (const row of rows) {
    const message =
      row.subject !== null
        ? { from: row.fromAddress, subject: row.subject, textBody: row.textBody, htmlBody: row.htmlBody, messageSource: "stored" as const }
        : await replay(row, templates);
    emails.push({
      id: row.id,
      eventType: row.eventType,
      recipientEmail: row.recipientEmail,
      orgId: internalOrgId(row.orgId),
      brandIds: row.brandIds,
      sentAt: row.sentAt!.toISOString(),
      ...message,
    });
  }

  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor(last.sentAt!, last.id) : opts.after ? encodeCursor(opts.after.sentAt, opts.after.id) : null;
  return { emails, nextCursor };
}
