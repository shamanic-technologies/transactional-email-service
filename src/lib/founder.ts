/**
 * The founder's address, hardcoded rather than env-configured for the same
 * reason `ADMIN_EMAILS` is: routing a human depends on cannot be allowed to
 * silently drift or be switched off by a variable nobody notices is missing.
 *
 * It serves two jobs, both about a person being reachable:
 *  - every email this service sends invites replies here, so a customer who
 *    hits reply reaches a human rather than whatever the sending address routes
 *    to (see `src/lib/email-gateway.ts`);
 *  - customer-facing sends are blind-copied here, so the company sees what it
 *    tells a customer as it tells them (see `src/routes/send.ts`).
 *
 * It is ONE address on purpose. A multi-address staff blind copy was removed in
 * PR #126 because Postmark bills per recipient and counted every blind copy, so
 * each send was multiplied by the size of the staff list. One address at this
 * service's volume (52 sends over the 14 days measured 2026-09-17, across every
 * event type) is a rounding error against that price. Do not grow this into a
 * list.
 */
export const FOUNDER_EMAIL = "kevin@distribute.you";
