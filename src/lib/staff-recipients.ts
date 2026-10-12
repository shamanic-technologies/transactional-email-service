import { FOUNDER_EMAIL } from "./founder.js";

/**
 * Where a staff-bound message goes.
 *
 * Hardcoded rather than env-configured so the routing cannot silently drift or
 * be disabled by a variable nobody set. It lives in its own module because two
 * callers need it and neither should own it: the `/send` route, which delivers
 * staff-routed event types here instead of to the customer, and the mailing-list
 * release worker, which has no request behind it at all.
 */
export const ADMIN_EMAILS = ["kevin.lourd@gmail.com"];

/**
 * The other addresses each staff recipient acts under, keyed by the recipient
 * address in ADMIN_EMAILS. A staff alert is about something somebody did; when
 * that somebody is the recipient, under ANY of their accounts, they already
 * know (owner: "when it is ME, whatever account"). This list widens who counts
 * as the same PERSON; it never adds a recipient.
 */
export const STAFF_IDENTITIES: Record<string, string[]> = {
  "kevin.lourd@gmail.com": [FOUNDER_EMAIL],
};

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

/** True when the acting address belongs to the person behind this staff recipient. */
export function isStaffRecipientActor(recipient: string, actor: unknown): boolean {
  const actorEmail = normalizeEmail(actor);
  const recipientEmail = normalizeEmail(recipient);
  if (!actorEmail || !recipientEmail) return false;
  const own = [recipientEmail, ...(STAFF_IDENTITIES[recipientEmail] ?? []).map((a) => normalizeEmail(a))];
  return own.includes(actorEmail);
}

/**
 * Every address a staff member reads: the staff recipient list plus each
 * recipient's other addresses (the agency inbox other services mail,
 * `kevin@distribute.you`, is one of them).
 */
export function isStaffAddress(address: unknown): boolean {
  const email = normalizeEmail(address);
  if (!email) return false;
  return ADMIN_EMAILS.some((recipient) => isStaffRecipientActor(recipient, email));
}

/**
 * Who pays for one send. A message whose every address (to, cc, bcc) is staff
 * is the platform's own internal mail: it is platform-paid, so it skips the
 * org's credit gate and costs that org nothing. A client out of money is the
 * exact case where staff most need the alert about it (2026-10-13: three
 * unanswered-question check-ins lost to a 402 on an org at -$96).
 *
 * Keyed on the ADDRESSES, never on the event type, so no caller can mail a
 * customer at the platform's expense: one non-staff address anywhere on the
 * message and the org pays, exactly as before.
 */
export function payerFor(addresses: string[]): "platform" | undefined {
  if (addresses.length === 0) return undefined;
  return addresses.every((address) => isStaffAddress(address)) ? "platform" : undefined;
}
