import { describe, it, expect } from "vitest";
import {
  assessOutcomes,
  estimateDaysRemaining,
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

describe("changing the pace of a release already under way", () => {
  it("makes the raised allowance spendable the same day, not at midnight", () => {
    // Noon, 100 of a 100-a-day allowance already spent: nothing more today.
    expect(tickAllowance({ dailyLimit: 100, sentToday: 100, now: at(12) })).toBe(0);
    // The pace is raised to 500 with no other change. The same instant now has
    // 400 left to spread over the ticks remaining in the day.
    expect(tickAllowance({ dailyLimit: 500, sentToday: 100, now: at(12) })).toBeGreaterThan(0);
  });

  it("rests for the rest of the day when the pace is lowered below what the day already sent", () => {
    expect(tickAllowance({ dailyLimit: 1_000, sentToday: 900, now: at(9) })).toBeGreaterThan(0);
    // Lowered to 100 after 900 have gone out. Nothing is clawed back and
    // nothing fails: the allowance is simply spent for today.
    expect(tickAllowance({ dailyLimit: 100, sentToday: 900, now: at(9) })).toBe(0);
    // And it stays 0 for the rest of the day, however late the tick.
    expect(tickAllowance({ dailyLimit: 100, sentToday: 900, now: at(23, 59) })).toBe(0);
  });

  it("gives the lowered pace a full allowance again the next day", () => {
    // A new UTC day means sentToday is 0 again; the lowered pace governs it.
    expect(tickAllowance({ dailyLimit: 100, sentToday: 0, now: at(0, 1) })).toBeGreaterThan(0);
    // Still capped by the per-tick ceiling: a fresh day late in the day is not
    // licence to put the whole allowance out in one wake.
    expect(tickAllowance({ dailyLimit: 100, sentToday: 0, now: at(23, 59) })).toBe(MAX_TICK_BATCH);
  });

  it("never lets a pace change hand out more than the day's new allowance", () => {
    // Whatever the pace was before, one day's sends can never exceed the pace
    // in force at the time — which is what keeps a raise from being a spike.
    let sentToday = 0;
    for (let minute = 0; minute < 1440; minute++) {
      sentToday += tickAllowance({ dailyLimit: 300, sentToday, now: at(Math.floor(minute / 60), minute % 60) });
    }
    expect(sentToday).toBe(300);
  });
});

describe("estimateDaysRemaining", () => {
  it("counts today when today can still carry somebody", () => {
    // 250 left, 100 a day, none sent today: today plus two more.
    expect(estimateDaysRemaining({ dailyLimit: 100, remaining: 250, todayUsed: 0 })).toBe(3);
  });

  it("drops today once today's allowance is spent", () => {
    // Same 250 waiting, but today is done: three whole days from tomorrow.
    expect(estimateDaysRemaining({ dailyLimit: 100, remaining: 250, todayUsed: 100 })).toBe(3);
    // 200 left with today spent is two more days, not three.
    expect(estimateDaysRemaining({ dailyLimit: 100, remaining: 200, todayUsed: 100 })).toBe(2);
  });

  it("shortens when the pace is raised and lengthens when it is lowered", () => {
    const remaining = 1_000;
    const slow = estimateDaysRemaining({ dailyLimit: 50, remaining, todayUsed: 0 });
    const fast = estimateDaysRemaining({ dailyLimit: 500, remaining, todayUsed: 0 });
    expect(slow).toBe(20);
    expect(fast).toBe(2);
  });

  it("rests today, without going negative, when the pace is lowered below what today sent", () => {
    // 900 went out today, then the pace was lowered to 100. Today is over; the
    // 600 still waiting take six days from tomorrow.
    expect(estimateDaysRemaining({ dailyLimit: 100, remaining: 600, todayUsed: 900 })).toBe(6);
  });

  it("is zero when nobody is waiting", () => {
    expect(estimateDaysRemaining({ dailyLimit: 100, remaining: 0, todayUsed: 40 })).toBe(0);
    expect(estimateDaysRemaining({ dailyLimit: 100, remaining: 0, todayUsed: 0 })).toBe(0);
  });

  it("never claims a day for fewer people than a day can carry", () => {
    expect(estimateDaysRemaining({ dailyLimit: 1_000, remaining: 1, todayUsed: 0 })).toBe(1);
    expect(estimateDaysRemaining({ dailyLimit: 1_000, remaining: 1, todayUsed: 1_000 })).toBe(1);
  });
});
