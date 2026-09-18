import { describe, it, expect } from "vitest";
import {
  assessOutcomes,
  HEALTH_MIN_SAMPLE,
  MAX_BOUNCE_RATE,
  MAX_DAILY_LIMIT,
  MAX_TICK_BATCH,
  MAX_UNSUBSCRIBE_RATE,
  startOfUtcDay,
  tickAllowance,
  WORKER_INTERVAL_MS,
} from "../../src/lib/release-pacing.js";
import { MAX_FILTERED_LOOKUPS } from "../../src/lib/suppression.js";

const MINUTE = 60_000;

/** A UTC instant, stated as a time of day so the tests read as clock positions. */
function at(hours: number, minutes = 0): Date {
  return new Date(Date.UTC(2026, 8, 18, hours, minutes, 0));
}

describe("startOfUtcDay", () => {
  it("is midnight UTC of the day containing the instant", () => {
    expect(startOfUtcDay(at(13, 47)).toISOString()).toBe("2026-09-18T00:00:00.000Z");
  });

  it("does not move for an instant already at midnight", () => {
    expect(startOfUtcDay(at(0, 0)).toISOString()).toBe("2026-09-18T00:00:00.000Z");
  });
});

describe("tickAllowance", () => {
  it("spreads the day's allowance across the ticks left in the day rather than spending it at midnight", () => {
    // 3,000 a day, nothing spent, a whole day of one-minute ticks ahead:
    // 3000 / 1440 ticks rounds to 3 — a trickle, which is the point.
    expect(tickAllowance({ dailyLimit: 3000, sentToday: 0, now: at(0, 0) })).toBe(3);
  });

  it("gives what is left to the last ticks of the day, because the allowance expires at midnight", () => {
    // Two minutes left, 40 still allowed today: 20 this tick, capped by MAX_TICK_BATCH.
    expect(tickAllowance({ dailyLimit: 40, sentToday: 0, now: at(23, 58) })).toBe(20);
    // One minute left and a small remainder: all of it.
    expect(tickAllowance({ dailyLimit: 7, sentToday: 0, now: at(23, 59) })).toBe(7);
  });

  it("never exceeds MAX_TICK_BATCH, whatever the daily limit says", () => {
    expect(tickAllowance({ dailyLimit: 30_000, sentToday: 0, now: at(23, 59) })).toBe(MAX_TICK_BATCH);
  });

  it("is zero once the day's allowance is spent, which is how a release rests between days", () => {
    expect(tickAllowance({ dailyLimit: 500, sentToday: 500, now: at(9, 0) })).toBe(0);
    expect(tickAllowance({ dailyLimit: 500, sentToday: 620, now: at(9, 0) })).toBe(0);
  });

  it("never exceeds what is left of the day's allowance", () => {
    expect(tickAllowance({ dailyLimit: 500, sentToday: 498, now: at(23, 59) })).toBe(2);
  });

  it("sums to the daily limit and no more across a whole day of ticks", () => {
    const dailyLimit = 3000;
    let sentToday = 0;
    for (let minute = 0; minute < 1440; minute++) {
      sentToday += tickAllowance({ dailyLimit, sentToday, now: at(0, 0 + minute) });
    }
    expect(sentToday).toBe(dailyLimit);
  });

  it("states the most it can deliver in a day rather than promising more than it keeps", () => {
    // The tick ceiling, every tick of the day, IS the daily ceiling. A release
    // asked for more would under-deliver every day and finish late in silence,
    // so the create route refuses a larger daily limit instead.
    expect(MAX_DAILY_LIMIT).toBe((MAX_TICK_BATCH * 86_400_000) / WORKER_INTERVAL_MS);
    expect(tickAllowance({ dailyLimit: MAX_DAILY_LIMIT, sentToday: 0, now: at(12, 0) })).toBe(MAX_TICK_BATCH);
  });

  it("spends a whole day's ceiling across a whole day of ticks, exactly", () => {
    let sentToday = 0;
    for (let minute = 0; minute < 1440; minute++) {
      sentToday += tickAllowance({ dailyLimit: MAX_DAILY_LIMIT, sentToday, now: at(0, minute) });
    }
    expect(sentToday).toBe(MAX_DAILY_LIMIT);
  });

  it("keeps a slice inside the per-address suppression read, rather than dumping the whole stream", () => {
    // A slice re-reads provider suppression for exactly its own addresses.
    // Past MAX_FILTERED_LOOKUPS that read becomes a dump of the shared
    // broadcast stream, whose size tracks total outreach volume instead of this
    // list. Pinned here so neither constant can drift past the other unnoticed.
    expect(MAX_TICK_BATCH).toBeLessThanOrEqual(MAX_FILTERED_LOOKUPS);
  });
});

describe("assessOutcomes", () => {
  it("decides nothing under the minimum sample, however bad the ratio looks", () => {
    const verdict = assessOutcomes({ sent: 20, bounced: 20, unsubscribed: 20 });
    expect(verdict.halt).toBe(false);
    expect(verdict.reason).toBeNull();
    // The rates are still reported: a thin sample is not a healthy one.
    expect(verdict.bounceRate).toBe(1);
  });

  it("halts on a bounce rate above the ceiling, naming the numbers", () => {
    const sent = HEALTH_MIN_SAMPLE * 2;
    const bounced = Math.ceil(sent * (MAX_BOUNCE_RATE + 0.01));
    const verdict = assessOutcomes({ sent, bounced, unsubscribed: 0 });

    expect(verdict.halt).toBe(true);
    expect(verdict.reason).toContain(`${bounced} of ${sent}`);
    expect(verdict.reason).toContain("bounced");
  });

  it("halts on an unsubscribe rate above the ceiling", () => {
    const sent = HEALTH_MIN_SAMPLE * 2;
    const unsubscribed = Math.ceil(sent * (MAX_UNSUBSCRIBE_RATE + 0.01));
    const verdict = assessOutcomes({ sent, bounced: 0, unsubscribed });

    expect(verdict.halt).toBe(true);
    expect(verdict.reason).toContain("unsubscribed");
  });

  it("does not halt exactly at a ceiling — the thresholds are what a release stops ABOVE", () => {
    const sent = 10_000;
    const verdict = assessOutcomes({
      sent,
      bounced: sent * MAX_BOUNCE_RATE,
      unsubscribed: sent * MAX_UNSUBSCRIBE_RATE,
    });
    expect(verdict.halt).toBe(false);
  });

  it("reports zero rates for a release nothing has been sent for, and does not halt it", () => {
    expect(assessOutcomes({ sent: 0, bounced: 0, unsubscribed: 0 })).toEqual({
      halt: false,
      reason: null,
      bounceRate: 0,
      unsubscribeRate: 0,
    });
  });
});

describe("the interval is stated as the bound, not inherited from a cron", () => {
  it("wakes at least once a minute", () => {
    expect(WORKER_INTERVAL_MS).toBeLessThanOrEqual(MINUTE);
  });
});
