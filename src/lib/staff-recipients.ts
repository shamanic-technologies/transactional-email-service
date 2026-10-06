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
