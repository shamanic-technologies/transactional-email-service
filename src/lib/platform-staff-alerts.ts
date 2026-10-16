// Staff alerts about a PLATFORM fact: something true of the fleet's shared
// infrastructure that belongs to no organisation and was done by nobody
// (POST /platform-staff-alert). There is no org to name, no user to resolve and
// nobody to bill, so the alert is declared on an org-less platform run and
// delivered to the staff recipient list (ADMIN_EMAILS) only; the caller never
// chooses a recipient.
//
// Each alert carries a caller-supplied `eventId` naming ONE occurrence of the
// fact (one listing of one domain on one list). The same event id delivers once,
// ever: a retry after a failed call sends, a retry after a delivered one answers
// `duplicate`. The caller owns WHEN a new occurrence starts (its latch); this
// service owns that one occurrence never mails twice.
//
// Keep the list closed: every name here is a staff email any holder of the
// service key can raise at the platform's expense.
//
// sending_domain_blocklisted: instantly-service, one of our cold-email SENDING
// domains newly landed on a public domain blocklist (SURBL, Spamhaus DBL,
// URIBL). Every client shares those domains, so no org owns the fact
// (DOMAIN-BLOCKLIST-1016).
//
// Its own module: tests `vi.mock` route dependencies whole, and src/schemas.ts
// reads this list at import time.
export const PLATFORM_STAFF_ALERTS: Record<string, readonly string[]> = {
  sending_domain_blocklisted: [
    "domain",
    "listName",
    "listedSince",
    "listAnswer",
    "mailboxesAffected",
    "actionTaken",
    "removalUrl",
  ],
};

export function isPlatformStaffAlert(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLATFORM_STAFF_ALERTS, eventType);
}

/** The dedup key of one occurrence for one staff recipient. */
export function platformStaffAlertDedupKey(eventType: string, eventId: string, recipient: string, recipientCount: number): string {
  const base = `platform-staff-alert:${eventType}:${eventId.trim()}`;
  return recipientCount > 1 ? `${base}:${recipient}` : base;
}
