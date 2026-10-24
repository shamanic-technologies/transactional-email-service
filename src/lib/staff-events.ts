import { isPlatformStaffAlert } from "./platform-staff-alerts.js";

// Events where recipient is hardcoded to admin.
// brand_daily_budget_changed is emitted by billing-service on every real change to a
// brand's daily budget. It belongs to no dedup set above, so every change notifies.
// payment_method_removed is emitted by stripe-service when a customer detaches a card
// inside Stripe's billing portal. It belongs to no dedup set above, so every removal
// notifies — losing one of two cards and going to zero are different situations.
// staff_daily_digest is emitted once a day by the customer dashboard, which owns and
// registers the template under that exact name. It belongs to no dedup set above: the
// dashboard decides when a digest goes out.
// provider_credits_exhausted is raised by any backend service that detects a paid
// third-party provider has run out of credits. It is deduped once per org per
// calendar day (ORG_DAILY_EVENTS) so a service hitting the wall on thousands of
// consecutive operations cannot mail-bomb.
// campaign_failing is raised by campaign-service when a campaign has failed every
// run for a sustained stretch (CAMPAIGN_DAILY_EVENTS bounds it per campaign per day).
// audience_refill_failed is raised by campaign-service when a campaign ran out of
// people and the automatic refill produced nobody new, at the moment the customer
// is asked to extend an audience (same per campaign per day bound).
// trigger_silent is raised by campaign-service when a reactive trigger has gone
// silent for days while live campaigns depend on it (TRIGGER_DAILY_EVENTS bounds
// it per trigger per day, fleet-wide).
// trigger_occurrence_stuck is raised by campaign-service when one trigger
// occurrence carrying a person or an item has waited undelivered because a
// campaign behind it cannot run (OCCURRENCE_ONCE_EVENTS: once per occurrence).
// unpaid_debt_uncollectable is emitted by billing-service when an org's balance has
// gone negative and there is no card on file to collect it on. It belongs to no dedup
// set above: billing-service decides when a debt is worth reporting, and two orgs
// going uncollectable on the same day are two separate pieces of news.
// The recipient list itself lives in lib/staff-recipients.ts, hardcoded rather
// than env-configured so the routing cannot silently drift or be disabled by a
// variable nobody set; the mailing-list release worker sends there too and has
// no request to read one from.
export const ADMIN_NOTIFICATION_EVENTS = new Set([
  "signup_notification",
  "signin_notification",
  "user_active",
  "brand_daily_budget_changed",
  "payment_method_removed",
  "staff_daily_digest",
  "provider_credits_exhausted",
  "unpaid_debt_uncollectable",
  "campaign_failing",
  "audience_refill_failed",
  "trigger_silent",
  "trigger_occurrence_stuck",
]);

/**
 * True when an event is delivered to the staff list instead of a client: an
 * alert ABOUT a client, never a message TO one. Such a send never appears in a
 * client's Unibox thread (GET /internal/sent-emails).
 */
export function isStaffRoutedEvent(eventType: string): boolean {
  return ADMIN_NOTIFICATION_EVENTS.has(eventType) || isPlatformStaffAlert(eventType);
}
