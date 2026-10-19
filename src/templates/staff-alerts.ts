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

/**
 * A paced mailing-list release stopped itself because the provider's own
 * delivery outcomes for it went bad. Nobody asked for this message, which is
 * exactly why it exists: the release is already stopped by the time it is sent,
 * and without it the first anyone would know is the day somebody wondered why
 * the remaining recipients never got the update.
 */
export const MAILING_LIST_RELEASE_HALTED_TEMPLATE: StaffTemplate = {
  name: "mailing_list_release_halted",
  subject: "Release of \u201c{{subject}}\u201d to {{slug}} stopped itself",
  htmlBody: [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;background-color:#f6f7f9;margin:0;padding:0;">`,
    `<tr><td style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">`,
    `<tr><td style="${CELL}padding-top:24px;padding-bottom:4px;font-size:18px;line-height:24px;font-weight:600;color:#111827;">A mailing-list release stopped itself</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:20px;font-size:14px;line-height:20px;color:#6b7280;">No further messages will go out for it. Nothing resumes on its own.</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Update</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{subject}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">List</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{slug}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Why it stopped</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{reason}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Reached before stopping</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{reached}} of {{recipientCount}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Release</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:24px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{releaseId}}</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ].join(""),
  textBody: [
    "A mailing-list release stopped itself.",
    "",
    "No further messages will go out for it. Nothing resumes on its own.",
    "",
    "Update: {{subject}}",
    "List: {{slug}}",
    "Why it stopped: {{reason}}",
    "Reached before stopping: {{reached}} of {{recipientCount}}",
    "Release: {{releaseId}}",
  ].join("\n"),
};

/**
 * A running release has sent nothing for a sustained stretch because something
 * it depends on keeps failing (email verification, most often). Unlike a halt,
 * nothing has been stopped: the worker keeps retrying every minute and resumes
 * on its own the moment the dependency answers. The message exists so that
 * "retrying" is not mistaken for "fine" for a whole night.
 */
export const MAILING_LIST_RELEASE_STALLED_TEMPLATE: StaffTemplate = {
  name: "mailing_list_release_stalled",
  subject: "Release of \u201c{{subject}}\u201d to {{slug}} is not sending",
  htmlBody: [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;background-color:#f6f7f9;margin:0;padding:0;">`,
    `<tr><td style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">`,
    `<tr><td style="${CELL}padding-top:24px;padding-bottom:4px;font-size:18px;line-height:24px;font-weight:600;color:#111827;">A mailing-list release is not sending</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:20px;font-size:14px;line-height:20px;color:#6b7280;">Every attempt since the time below sent nothing. It retries every minute and resumes by itself once the cause is fixed. You will not get this email again for the same stall.</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Update</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{subject}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">List</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{slug}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Nothing sent since</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{stalledSince}} ({{stallTicks}} attempts)</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Reached so far</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{reached}} of {{recipientCount}}, {{remaining}} waiting</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Why, as the last attempt reported it</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;white-space:pre-wrap;">{{reason}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Release</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:24px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{releaseId}}</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ].join(""),
  textBody: [
    "A mailing-list release is not sending.",
    "",
    "Every attempt since the time below sent nothing. It retries every minute and resumes by itself once the cause is fixed. You will not get this email again for the same stall.",
    "",
    "Update: {{subject}}",
    "List: {{slug}}",
    "Nothing sent since: {{stalledSince}} ({{stallTicks}} attempts)",
    "Reached so far: {{reached}} of {{recipientCount}}, {{remaining}} waiting",
    "Why, as the last attempt reported it: {{reason}}",
    "Release: {{releaseId}}",
  ].join("\n"),
};

/**
 * A campaign has failed every run for a sustained stretch. Raised by
 * campaign-service once per failing episode. Nothing has been stopped: the
 * campaign keeps retrying on a widening interval and goes back to its normal
 * cadence on its first success. The customer is not told by this message.
 */
export const CAMPAIGN_FAILING_TEMPLATE: StaffTemplate = {
  name: "campaign_failing",
  subject: "Campaign {{campaignName}} keeps failing",
  htmlBody: [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;background-color:#f6f7f9;margin:0;padding:0;">`,
    `<tr><td style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">`,
    `<tr><td style="${CELL}padding-top:24px;padding-bottom:4px;font-size:18px;line-height:24px;font-weight:600;color:#111827;">A campaign keeps failing</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:20px;font-size:14px;line-height:20px;color:#6b7280;">Every run since the time below failed. The campaign is not stopped. It retries less often now and goes back to normal on its first success. The customer was not told. You will not get this email again for the same stretch.</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Campaign</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{campaignName}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Failing since</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{failingSince}} ({{consecutiveFailures}} failed runs in a row)</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Next retry in</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{retryInterval}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Feature</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{featureSlug}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Organisation</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{orgId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Brand</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{brandId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Campaign id</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{campaignId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Where to look</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:24px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;white-space:pre-wrap;">{{whereToLook}}</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ].join(""),
  textBody: [
    "A campaign keeps failing.",
    "",
    "Every run since the time below failed. The campaign is not stopped. It retries less often now and goes back to normal on its first success. The customer was not told. You will not get this email again for the same stretch.",
    "",
    "Campaign: {{campaignName}}",
    "Failing since: {{failingSince}} ({{consecutiveFailures}} failed runs in a row)",
    "Next retry in: {{retryInterval}}",
    "Feature: {{featureSlug}}",
    "Organisation: {{orgId}}",
    "Brand: {{brandId}}",
    "Campaign id: {{campaignId}}",
    "Where to look: {{whereToLook}}",
  ].join("\n"),
};

/**
 * A campaign ran out of people and the automatic audience refill could not give
 * it anybody new. Raised by campaign-service at the same moment the customer is
 * emailed asking them to extend an audience, so a human can step in. Nothing
 * here is sent to the customer.
 */
export const AUDIENCE_REFILL_FAILED_TEMPLATE: StaffTemplate = {
  name: "audience_refill_failed",
  subject: "Campaign {{campaignName}} is out of people and the refill did not help",
  htmlBody: [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;background-color:#f6f7f9;margin:0;padding:0;">`,
    `<tr><td style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">`,
    `<tr><td style="${CELL}padding-top:24px;padding-bottom:4px;font-size:18px;line-height:24px;font-weight:600;color:#111827;">A campaign is out of people</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:20px;font-size:14px;line-height:20px;color:#6b7280;">This campaign has contacted everyone it had. We tried to build new audiences for the brand automatically. It did not give us anyone new. The client was just emailed and asked to extend an audience. Please step in: build audiences by hand or talk to the client.</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Brand</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{brandName}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Campaign</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{campaignName}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Why the refill did not help</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{refillOutcome}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Details</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;white-space:pre-wrap;">{{refillDetail}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Organisation</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{orgId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Brand id</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{brandId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Campaign id</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{campaignId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Where to look</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:24px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;white-space:pre-wrap;">{{whereToLook}}</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ].join(""),
  textBody: [
    "A campaign is out of people.",
    "",
    "This campaign has contacted everyone it had. We tried to build new audiences for the brand automatically. It did not give us anyone new. The client was just emailed and asked to extend an audience. Please step in: build audiences by hand or talk to the client.",
    "",
    "Brand: {{brandName}}",
    "Campaign: {{campaignName}}",
    "Why the refill did not help: {{refillOutcome}}",
    "Details: {{refillDetail}}",
    "Organisation: {{orgId}}",
    "Brand id: {{brandId}}",
    "Campaign id: {{campaignId}}",
    "Where to look: {{whereToLook}}",
  ].join("\n"),
};

/**
 * A reactive trigger (e.g. "positive reply received") has produced no event for
 * days while live campaigns depend on it. Raised by campaign-service, at most
 * once per trigger per day. FLEET-WIDE: the trigger list is the same for every
 * customer, so this names no organisation (the org on the request is only there
 * so billing can authorize the send). A trigger that never fires is a broken
 * pipeline step, not a quiet day.
 */
export const TRIGGER_SILENT_TEMPLATE: StaffTemplate = {
  name: "trigger_silent",
  subject: "Trigger {{triggerLabel}} has been silent for {{silentDays}} days",
  htmlBody: [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;background-color:#f6f7f9;margin:0;padding:0;">`,
    `<tr><td style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">`,
    `<tr><td style="${CELL}padding-top:24px;padding-bottom:4px;font-size:18px;line-height:24px;font-weight:600;color:#111827;">A trigger has gone silent</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:20px;font-size:14px;line-height:20px;color:#6b7280;">This trigger has not fired since the time below. Live campaigns wait on it, so they are doing nothing. A trigger that never fires is usually broken, not quiet. This is about every client, not one. You will get this at most once a day per trigger.</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Trigger</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{triggerLabel}} ({{triggerId}})</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Silent since</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{silentSince}} ({{silentDays}} days)</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Live campaigns waiting on it</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{liveCampaignCount}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Should be fired by</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{firedBy}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Where to look</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:24px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;white-space:pre-wrap;">{{whereToLook}}</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ].join(""),
  textBody: [
    "A trigger has gone silent.",
    "",
    "This trigger has not fired since the time below. Live campaigns wait on it, so they are doing nothing. A trigger that never fires is usually broken, not quiet. This is about every client, not one. You will get this at most once a day per trigger.",
    "",
    "Trigger: {{triggerLabel}} ({{triggerId}})",
    "Silent since: {{silentSince}} ({{silentDays}} days)",
    "Live campaigns waiting on it: {{liveCampaignCount}}",
    "Should be fired by: {{firedBy}}",
    "Where to look: {{whereToLook}}",
  ].join("\n"),
};

/**
 * One trigger occurrence carrying a person or an item (a form filled, a reply)
 * has waited undelivered because a campaign behind it cannot run. Raised by
 * campaign-service at most once per occurrence: a prospect is waiting for an
 * automatic answer that is not coming. Nothing here is sent to the customer.
 */
export const TRIGGER_OCCURRENCE_STUCK_TEMPLATE: StaffTemplate = {
  name: "trigger_occurrence_stuck",
  subject: "A prospect has been waiting since {{waitingSince}} ({{attempts}} attempts)",
  htmlBody: [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;background-color:#f6f7f9;margin:0;padding:0;">`,
    `<tr><td style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">`,
    `<tr><td style="${CELL}padding-top:24px;padding-bottom:4px;font-size:18px;line-height:24px;font-weight:600;color:#111827;">A prospect is waiting for an answer</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:20px;font-size:14px;line-height:20px;color:#6b7280;">A prospect did something that should get an automatic answer. The campaign that answers cannot run, so nothing went out yet. We keep retrying. The client was not told. You get this email once per waiting event.</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Who is waiting</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{prospect}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Waiting since</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{waitingSince}} ({{attempts}} attempts)</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Campaign holding it back</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{campaignName}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Last error</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;white-space:pre-wrap;">{{lastError}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Trigger</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{triggerLabel}} ({{triggerId}})</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Event id</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{occurrenceId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Campaign id</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{campaignId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Organisation</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{orgId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Brand id</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{brandId}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Where to look</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:24px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;white-space:pre-wrap;">{{whereToLook}}</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ].join(""),
  textBody: [
    "A prospect is waiting for an answer.",
    "",
    "A prospect did something that should get an automatic answer. The campaign that answers cannot run, so nothing went out yet. We keep retrying. The client was not told. You get this email once per waiting event.",
    "",
    "Who is waiting: {{prospect}}",
    "Waiting since: {{waitingSince}} ({{attempts}} attempts)",
    "Campaign holding it back: {{campaignName}}",
    "Last error: {{lastError}}",
    "Trigger: {{triggerLabel}} ({{triggerId}})",
    "Event id: {{occurrenceId}}",
    "Campaign id: {{campaignId}}",
    "Organisation: {{orgId}}",
    "Brand id: {{brandId}}",
    "Where to look: {{whereToLook}}",
  ].join("\n"),
};

/**
 * One of our cold-email SENDING domains newly landed on a public domain
 * blocklist (SURBL, Spamhaus DBL, URIBL). Raised by instantly-service through
 * POST /platform-staff-alert, once per listing event: the domain is shared by
 * every client, so this names no organisation. The mailboxes are already out
 * of new sequences when it arrives; what is left for staff is the removal
 * request.
 */
export const SENDING_DOMAIN_BLOCKLISTED_TEMPLATE: StaffTemplate = {
  name: "sending_domain_blocklisted",
  subject: "{{domain}} is on the {{listName}} blocklist",
  htmlBody: [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;background-color:#f6f7f9;margin:0;padding:0;">`,
    `<tr><td style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">`,
    `<tr><td style="${CELL}padding-top:24px;padding-bottom:4px;font-size:18px;line-height:24px;font-weight:600;color:#111827;">{{domain}} is on the {{listName}} blocklist</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:20px;font-size:14px;line-height:20px;color:#6b7280;">One of our sending domains landed on a public blocklist. Every client shares this domain. Its mailboxes no longer start new sequences. The next step is yours: ask the list to remove the domain with the link below. You get this once for this listing.</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Domain</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{domain}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">List</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{listName}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Listed since</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{listedSince}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">What the list answered</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{listAnswer}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Mailboxes affected</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:16px;font-size:13px;line-height:19px;color:#374151;word-break:break-all;">{{mailboxesAffected}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">What we did automatically</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{actionTaken}}</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Request removal</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:24px;font-size:14px;line-height:20px;word-break:break-all;"><a href="{{removalUrl}}" style="color:#2563eb;text-decoration:underline;">{{removalUrl}}</a></td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ].join(""),
  textBody: [
    "{{domain}} is on the {{listName}} blocklist.",
    "",
    "One of our sending domains landed on a public blocklist. Every client shares this domain. Its mailboxes no longer start new sequences. The next step is yours: ask the list to remove the domain with the link below. You get this once for this listing.",
    "",
    "Domain: {{domain}}",
    "List: {{listName}}",
    "Listed since: {{listedSince}}",
    "What the list answered: {{listAnswer}}",
    "Mailboxes affected: {{mailboxesAffected}}",
    "What we did automatically: {{actionTaken}}",
    "Request removal: {{removalUrl}}",
  ].join("\n"),
};

/**
 * Inbox placement at one inbox provider fell below the market bar, measured on
 * the mailboxes still allowed to mail that provider: the automatic cut of bad
 * mailboxes already ran and did not bring it back. Raised by instantly-service
 * through POST /platform-staff-alert, once per provider per episode below the
 * bar (MAILBOX-MONITORING-1019). Staff mail, readable in 5 seconds.
 */
export const INBOX_PLACEMENT_BELOW_BAR_TEMPLATE: StaffTemplate = {
  name: "inbox_placement_below_bar",
  subject: "{{provider}} inbox placement is {{inboxPct}}%, below the {{thresholdPct}}% bar",
  htmlBody: [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;background-color:#f6f7f9;margin:0;padding:0;">`,
    `<tr><td style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;width:100%;max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">`,
    `<tr><td style="${CELL}padding-top:24px;padding-bottom:4px;font-size:18px;line-height:24px;font-weight:600;color:#111827;">{{provider}} inbox placement is {{inboxPct}}%</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:20px;font-size:14px;line-height:20px;color:#6b7280;">Our seed test puts too much of our mail in spam at {{provider}}. The automatic cut already took {{mailboxesCut}} mailboxes off {{provider}}. The mailboxes still mailing {{provider}} stay below the bar. You get this once until {{provider}} is back above the bar.</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Inbox at {{provider}}</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{inboxPct}}% of {{seeds}} seeds (bar {{thresholdPct}}%)</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Measured on</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{measuredOn}} (UTC)</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">What we did automatically</td></tr>`,
    `<tr><td style="${VALUE}padding-bottom:16px;">{{mailboxesCut}} mailboxes no longer mail {{provider}} prospects.</td></tr>`,
    `<tr><td style="${LABEL}padding-bottom:2px;">Where to look</td></tr>`,
    `<tr><td style="${CELL}padding-bottom:24px;font-size:14px;line-height:20px;word-break:break-all;"><a href="{{dashboardUrl}}" style="color:#2563eb;text-decoration:underline;">{{dashboardUrl}}</a></td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ].join(""),
  textBody: [
    "{{provider}} inbox placement is {{inboxPct}}%.",
    "",
    "Our seed test puts too much of our mail in spam at {{provider}}. The automatic cut already took {{mailboxesCut}} mailboxes off {{provider}}. The mailboxes still mailing {{provider}} stay below the bar. You get this once until {{provider}} is back above the bar.",
    "",
    "Inbox at {{provider}}: {{inboxPct}}% of {{seeds}} seeds (bar {{thresholdPct}}%)",
    "Measured on: {{measuredOn}} (UTC)",
    "What we did automatically: {{mailboxesCut}} mailboxes no longer mail {{provider}} prospects.",
    "Where to look: {{dashboardUrl}}",
  ].join("\n"),
};

export const STAFF_TEMPLATES: StaffTemplate[] = [
  PROVIDER_CREDITS_EXHAUSTED_TEMPLATE,
  MAILING_LIST_RELEASE_HALTED_TEMPLATE,
  MAILING_LIST_RELEASE_STALLED_TEMPLATE,
  CAMPAIGN_FAILING_TEMPLATE,
  AUDIENCE_REFILL_FAILED_TEMPLATE,
  TRIGGER_SILENT_TEMPLATE,
  TRIGGER_OCCURRENCE_STUCK_TEMPLATE,
  SENDING_DOMAIN_BLOCKLISTED_TEMPLATE,
  INBOX_PLACEMENT_BELOW_BAR_TEMPLATE,
];

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
        layout: "none",
      })
      .onConflictDoUpdate({
        target: [emailTemplates.name],
        set: {
          subject: tpl.subject,
          htmlBody: tpl.htmlBody,
          textBody: tpl.textBody,
          layout: "none",
          updatedAt: new Date(),
        },
      });
  }
}
