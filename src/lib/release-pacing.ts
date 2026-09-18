/**
 * How fast a release goes out, and when it is in bad enough shape to stop
 * itself. Both are pure functions over numbers, deliberately: they are the two
 * decisions in this feature whose being wrong is expensive and invisible, so
 * they are testable without a database, a clock or a provider.
 */

/**
 * How often the in-process worker wakes. This IS the latency bound between a
 * release becoming due for its next slice and that slice going out — it is not
 * a description of a cron's declared cadence, which is a promise nothing keeps
 * (measured elsewhere in this fleet at 6.2 runs a day against 24 declared).
 * The cron that also calls the tick route is a backstop for a process that died,
 * not the mechanism.
 */
export const WORKER_INTERVAL_MS = 60_000;

/**
 * The most messages one tick will send for one release, whatever its daily
 * allowance says. A release of 30,000 at 3,000 a day would otherwise put the
 * whole day's allowance out in the first minute after midnight, which is the
 * shape of a spike this feature exists to avoid: the provider's complaint
 * threshold applies to the whole account, so a spike here suspends onboarding
 * and dunning mail too.
 *
 * The value is not free: every slice re-reads the provider's suppression state
 * for exactly the addresses in it, and `MAX_FILTERED_LOOKUPS` in lib/suppression
 * is where that read stops being per-address and becomes a dump of the whole
 * broadcast stream — whose size tracks total outreach volume rather than this
 * list. A tick at or under that number keeps the reconcile small, and
 * tests/lib/release-pacing.test.ts pins the two together so neither can drift
 * past the other unnoticed.
 */
export const MAX_TICK_BATCH = 20;

/**
 * The most a release can send in one UTC day: the tick ceiling, every tick of
 * the day.
 *
 * It is a real bound, not a formality — a daily limit stated above it is a pace
 * this worker cannot keep, and the failure would be silent (the release simply
 * under-delivers every day and finishes late). So the create route refuses it
 * rather than accepting a number it will quietly ignore. At the current values
 * that is 28,800 a day, comfortably above any pace a sending subdomain two
 * weeks old should be asked for, and below the 30,013 of the `newsletter` list
 * — which is the point: that list is not something to send in one day.
 */
export const MAX_DAILY_LIMIT = Math.floor((MAX_TICK_BATCH * 86_400_000) / WORKER_INTERVAL_MS);

/**
 * A claim a worker took and never settled — the process was killed between the
 * claim and the outcome. Older than this and the row is settled as failed with
 * that named reason rather than returned to pending: a newsletter delivered
 * twice is worse than one that names an address it could not account for, and
 * the provider gives us no way to ask whether that one message left.
 */
export const CLAIM_STALE_MS = 10 * 60_000;

/** Reason written on a recipient whose claim outlived a worker. */
export const INTERRUPTED_REASON =
  "The worker was stopped between claiming this address and learning the outcome. Not re-sent: this service cannot ask the provider whether that one message left, and mailing somebody twice is worse than naming them here.";

/** Below this many settled sends a release's outcome rates are too thin to act on. */
export const HEALTH_MIN_SAMPLE = 500;

/** Bounce rate above which a release stops itself. Postmark's own account-level danger zone. */
export const MAX_BOUNCE_RATE = 0.05;

/** Unsubscribe rate above which a release stops itself. */
export const MAX_UNSUBSCRIBE_RATE = 0.03;

/** How often a running release's delivery outcomes are read back from the provider. */
export const HEALTH_CHECK_INTERVAL_MS = 10 * 60_000;

/** The start of the UTC calendar day containing `now`. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * How many messages this tick may send.
 *
 * The day's remaining allowance is spread over the ticks left in the day rather
 * than spent as fast as the worker can wake. Two consequences worth stating:
 * a release created at 23:58 sends its whole day's allowance in those two
 * minutes, which is correct — that allowance expires at midnight — and a
 * release created at 00:01 trickles, which is the point.
 *
 * Returns 0 when the day's allowance is spent, which is how a release rests
 * between days without anything holding a connection open.
 */
export function tickAllowance(input: {
  dailyLimit: number;
  sentToday: number;
  now: Date;
  intervalMs?: number;
  maxBatch?: number;
}): number {
  const { dailyLimit, sentToday, now } = input;
  const intervalMs = input.intervalMs ?? WORKER_INTERVAL_MS;
  const maxBatch = input.maxBatch ?? MAX_TICK_BATCH;

  const remainingToday = dailyLimit - sentToday;
  if (remainingToday <= 0) return 0;

  const msLeftToday = startOfUtcDay(now).getTime() + 86_400_000 - now.getTime();
  // At least one tick is always left: the one running right now.
  const ticksLeftToday = Math.max(1, Math.ceil(msLeftToday / intervalMs));

  return Math.min(maxBatch, remainingToday, Math.ceil(remainingToday / ticksLeftToday));
}

export interface DeliveryOutcomes {
  sent: number;
  bounced: number;
  unsubscribed: number;
}

export interface HealthVerdict {
  /** True when the release must stop itself. */
  halt: boolean;
  /** Why, in the words the staff alert repeats. Null when it is not halting. */
  reason: string | null;
  bounceRate: number;
  unsubscribeRate: number;
}

/**
 * Read the provider's own outcomes for this release and say whether it should
 * keep going.
 *
 * Under `HEALTH_MIN_SAMPLE` sends nothing is decided — a handful of bounces out
 * of twenty is noise, and halting on it would stop every release on its first
 * slice. That is not the same as calling a thin sample healthy: the verdict
 * simply is not "halt", and the next tick asks again with more evidence.
 */
export function assessOutcomes(outcomes: DeliveryOutcomes): HealthVerdict {
  const { sent, bounced, unsubscribed } = outcomes;
  const bounceRate = sent > 0 ? bounced / sent : 0;
  const unsubscribeRate = sent > 0 ? unsubscribed / sent : 0;

  if (sent < HEALTH_MIN_SAMPLE) {
    return { halt: false, reason: null, bounceRate, unsubscribeRate };
  }

  const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;

  if (bounceRate > MAX_BOUNCE_RATE) {
    return {
      halt: true,
      reason:
        `${bounced} of ${sent} messages bounced (${percent(bounceRate)}), above the ${percent(MAX_BOUNCE_RATE)} ` +
        `this release stops itself at. A bounce rate this high is read by the provider against the whole account, ` +
        `so continuing would put transactional mail at risk too.`,
      bounceRate,
      unsubscribeRate,
    };
  }

  if (unsubscribeRate > MAX_UNSUBSCRIBE_RATE) {
    return {
      halt: true,
      reason:
        `${unsubscribed} of ${sent} recipients unsubscribed (${percent(unsubscribeRate)}), above the ` +
        `${percent(MAX_UNSUBSCRIBE_RATE)} this release stops itself at. The remaining days would carry the same ` +
        `message to people this rate says do not want it.`,
      bounceRate,
      unsubscribeRate,
    };
  }

  return { halt: false, reason: null, bounceRate, unsubscribeRate };
}

/**
 * How many more UTC days this release needs at its current pace.
 *
 * Stated from where the release actually stands rather than from its size, so
 * it answers the question a staff member asks after changing the pace: given
 * what is left and what today has already spent, how much longer. Today counts
 * as one of those days only when today can still carry somebody — a release
 * whose allowance is spent, including one whose pace was just lowered below
 * what the day already sent, rests until tomorrow and says so.
 *
 * Zero means nobody is waiting. It is deliberately arithmetic over the pace and
 * the ledger and nothing else: it makes no claim about the worker's health, the
 * provider's outcomes, or a release that is not going to run again.
 */
export function estimateDaysRemaining(input: {
  dailyLimit: number;
  remaining: number;
  todayUsed: number;
}): number {
  const { dailyLimit, remaining, todayUsed } = input;
  if (remaining <= 0) return 0;

  const todayLeft = Math.max(0, Math.min(dailyLimit - todayUsed, remaining));
  const afterToday = remaining - todayLeft;

  return (todayLeft > 0 ? 1 : 0) + Math.ceil(afterToday / dailyLimit);
}
