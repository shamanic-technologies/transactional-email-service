import { and, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailEvents } from "../db/schema.js";

// A monitoring alert is RECORDED, never emailed (owner 2026-10-22: « no email in
// my inbox please »; SIGNUP-EMAILS-1111). Callers keep raising them on the same
// routes, with the same validation and the same dedup bound; the row is written
// with status `recorded` and nothing goes to the gateway: no run, no template,
// no spend. Staff read them on dashboard v2 Monitoring through
// GET /internal/monitoring-alerts, red while one was raised in the last 24 h.
//
// Business news staff ASKED to be mailed (a signup, a payment method removed,
// the daily digest, an uncollectable debt) is not a monitoring alert and keeps
// its email. Adding a name here stops an email: keep it to "something is broken".
//
// Own module: route tests `vi.mock` their dependencies whole.
export const MONITORING_ALERTS: Record<string, string> = {
  provider_credits_exhausted: "A paid data provider is out of credits",
  campaign_failing: "A campaign fails every run",
  audience_refill_failed: "A campaign ran out of people and the refill found nobody",
  trigger_silent: "A trigger has been silent for days",
  trigger_occurrence_stuck: "A prospect waits on a campaign that cannot run",
  sending_domain_blocklisted: "A sending domain is on a blocklist",
  mailing_list_release_halted: "A newsletter release stopped itself",
  mailing_list_release_stalled: "A newsletter release stopped moving",
};

export const ALERT_RECORDED = "recorded";

export function isMonitoringAlert(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(MONITORING_ALERTS, eventType);
}

/** Broken = raised within this window; older alerts are history, not a red light. */
const BROKEN_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 20;

export interface MonitoringAlertFeed {
  days: number;
  generatedAt: string;
  alerts: Array<{
    eventType: string;
    label: string;
    verdict: "broken" | "ok";
    reason: string;
    lastRaisedAt: string | null;
    daily: Array<{ day: string; count: number }>;
    recent: Array<{
      raisedAt: string;
      orgId: string | null;
      campaignId: string | null;
      metadata: Record<string, unknown> | null;
    }>;
  }>;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Every monitoring alert type with its daily series over `days` UTC days (today
 * included, zero-filled) and its latest occurrences. Rows emailed before
 * SIGNUP-EMAILS-1111 (status sent/failed) count too: an alert raised is a fact
 * whatever happened to its email. Broken alerts first, then by name.
 */
export async function readMonitoringAlerts(days: number, now = new Date()): Promise<MonitoringAlertFeed> {
  const types = Object.keys(MONITORING_ALERTS);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));

  const counts = await db
    .select({
      eventType: emailEvents.eventType,
      day: sql<string>`to_char(${emailEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
      last: sql<Date>`max(${emailEvents.createdAt})`,
    })
    .from(emailEvents)
    .where(and(inArray(emailEvents.eventType, types), gte(emailEvents.createdAt, start)))
    .groupBy(emailEvents.eventType, sql`2`);

  const typeList = sql.join(types.map((t) => sql`${t}`), sql`, `);
  const recentRows = (await db.execute(sql`
    SELECT event_type, created_at, org_id, campaign_id, metadata
      FROM (
        SELECT event_type, created_at, org_id, campaign_id, metadata,
               row_number() OVER (PARTITION BY event_type ORDER BY created_at DESC) AS rn
          FROM email_events
         WHERE event_type IN (${typeList}) AND created_at >= ${start.toISOString()}::timestamptz
      ) ranked
     WHERE rn <= ${RECENT_LIMIT}
     ORDER BY created_at DESC
  `)) as unknown as Array<{ event_type: string; created_at: Date | string; org_id: string | null; campaign_id: string | null; metadata: unknown }>;

  const dayKeys: string[] = [];
  for (let i = 0; i < days; i++) dayKeys.push(utcDay(new Date(start.getTime() + i * 86_400_000)));

  const alerts = types.map((eventType) => {
    const perDay = new Map<string, number>();
    let last: Date | null = null;
    for (const row of counts) {
      if (row.eventType !== eventType) continue;
      perDay.set(row.day, row.count);
      const rowLast = new Date(row.last);
      if (!last || rowLast > last) last = rowLast;
    }
    const broken = last !== null && now.getTime() - last.getTime() <= BROKEN_WINDOW_MS;
    const total = [...perDay.values()].reduce((a, b) => a + b, 0);
    const reason = broken
      ? `Raised ${total} time${total === 1 ? "" : "s"} in ${days} days, last at ${last!.toISOString()}`
      : total > 0
        ? `Not raised in the last 24 h (${total} in ${days} days)`
        : `Not raised in ${days} days`;
    return {
      eventType,
      label: MONITORING_ALERTS[eventType],
      verdict: (broken ? "broken" : "ok") as "broken" | "ok",
      reason,
      lastRaisedAt: last ? last.toISOString() : null,
      daily: dayKeys.map((day) => ({ day, count: perDay.get(day) ?? 0 })),
      recent: recentRows
        .filter((r) => r.event_type === eventType)
        .map((r) => ({
          raisedAt: new Date(r.created_at).toISOString(),
          orgId: r.org_id,
          campaignId: r.campaign_id,
          metadata: (r.metadata as Record<string, unknown> | null) ?? null,
        })),
    };
  });

  alerts.sort((a, b) => (a.verdict === b.verdict ? a.eventType.localeCompare(b.eventType) : a.verdict === "broken" ? -1 : 1));
  return { days, generatedAt: now.toISOString(), alerts };
}
