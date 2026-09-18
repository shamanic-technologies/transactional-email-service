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
