import { db } from "../db/index.js";
import { emailTemplates } from "../db/schema.js";

/**
 * Staff-alert templates owned by this service.
 *
 * Product templates are not stored here — each consuming app declares its own
 * and registers them at startup via `PUT /templates` (see CLAUDE.md). A staff
 * alert is the exception, and deliberately so: no consuming app owns it. Any
 * backend service can raise `provider_credits_exhausted`, so leaving the
 * template to the caller would mean every future caller shipping its own copy
 * of the same staff email, which is exactly the drift the hardcoded staff
 * recipient list in `send.ts` exists to prevent. The service that owns the
 * staff recipient list owns the staff template with it.
 *
 * Styling rules (CLAUDE.md "Email HTML"): every element is styled inline,
 * layout is nested tables, and the outer table is `table-layout: fixed` with
 * stated column widths so a long raw upstream payload cannot push the document
 * wider than a 375px screen.
 */
export interface StaffTemplate {
  name: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

const CELL = "padding:0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
const LABEL = `${CELL}font-size:12px;line-height:16px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;`;
const VALUE = `${CELL}font-size:15px;line-height:22px;color:#111827;word-break:break-word;`;

export const PROVIDER_CREDITS_EXHAUSTED_TEMPLATE: StaffTemplate = {
  name: "provider_credits_exhausted",
  subject: "{{provider}} is out of credits",
  htmlBody: [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;background-color:#f6f7f9;margin:0;padding:0;">`,
    `<tr><td style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">`,
    `<tr><td style="${CELL}padding-top:24px;padding-bottom:4px;font-size:18px;line-height:24px;font-weight:600;color:#111827;">{{provider}} is out of credits</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:20px;font-size:14px;line-height:20px;color:#6b7280;">Work that depends on this provider is producing nothing until the balance is topped up.</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Provider</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{provider}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Why we concluded this</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{reason}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Organisation</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{orgId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Upstream detail</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:24px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;white-space:pre-wrap;">{{detail}}</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ].join(""),
  textBody: [
    "{{provider}} is out of credits.",
    "",
    "Work that depends on this provider is producing nothing until the balance is topped up.",
    "",
    "Provider: {{provider}}",
    "Why we concluded this: {{reason}}",
    "Organisation: {{orgId}}",
    "Upstream detail: {{detail}}",
  ].join("\n"),
};

export const STAFF_TEMPLATES: StaffTemplate[] = [PROVIDER_CREDITS_EXHAUSTED_TEMPLATE];

/**
 * Register the staff-alert templates. Runs on boot, after migrations and
 * before the port is bound: one upsert per template, so it is O(1) and cannot
 * stretch the boot window. This repo is the source of truth for these rows, so
 * a shipped edit overwrites what is in the database.
 */
export async function seedStaffTemplates(): Promise<void> {
  for (const tpl of STAFF_TEMPLATES) {
    await db
      .insert(emailTemplates)
      .values({
        name: tpl.name,
        subject: tpl.subject,
        htmlBody: tpl.htmlBody,
        textBody: tpl.textBody,
      })
      .onConflictDoUpdate({
        target: [emailTemplates.name],
        set: {
          subject: tpl.subject,
          htmlBody: tpl.htmlBody,
          textBody: tpl.textBody,
          updatedAt: new Date(),
        },
      });
  }
}
