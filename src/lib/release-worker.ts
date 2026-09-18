import { and, eq, inArray, sql as raw } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  mailingListReleaseRecipients,
  mailingListReleases,
  mailingLists,
  type MailingListRelease,
} from "../db/schema.js";
import { sendEmail } from "../lib/email-gateway.js";
import { fetchSuppressed } from "../lib/suppression.js";
import { fetchDeliveryOutcomes } from "../lib/release-health.js";
import { getTemplate } from "../templates/index.js";
import { ADMIN_EMAILS } from "../lib/staff-recipients.js";
import { updateRun } from "../lib/runs-client.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  assessOutcomes,
  CLAIM_STALE_MS,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_MIN_SAMPLE,
  INTERRUPTED_REASON,
  startOfUtcDay,
  tickAllowance,
  WORKER_INTERVAL_MS,
} from "./release-pacing.js";

/**
 * What actually releases a mailing-list update over several days.
 *
 * It is an interval armed after the port is bound, not a cron. A cron in this
 * fleet declares a cadence it does not deliver — measured at 6.2 runs a day
 * against 24 declared, with gaps of hours — and a release has a deadline in the
 * same sense a dunning email does: the pace staff stated is the product, so
 * missing four hours of it is missing the feature. `WORKER_INTERVAL_MS` is the
 * bound between a slice becoming due and going out, and the tick route exists
 * so a cron can act as a backstop for a process that died, never as the
 * mechanism.
 *
 * Three properties the code below exists to hold:
 *
 *  - **Nobody is mailed twice.** A recipient row is claimed by an UPDATE that
 *    only moves rows out of `pending`, under `FOR UPDATE SKIP LOCKED`, so two
 *    callers of the tick — the interval, the route, a hand-run — cannot hand the
 *    same address to two sends. The unique index on (release, email) means the
 *    ledger cannot grow a second row for somebody either.
 *  - **Nobody is lost.** Every address is a row from the moment the release is
 *    created, and every row ends in a terminal status with a reason. A claim a
 *    killed process left behind is settled as failed, naming what happened,
 *    rather than returned to the queue: this service cannot ask the provider
 *    whether that one message left, and a newsletter delivered twice is worse
 *    than one address reported honestly.
 *  - **Suppression is reconciled per slice.** Each slice re-reads the provider
 *    for exactly its own addresses with no cache at all, so somebody who
 *    unsubscribes on day one is skipped on day five.
 */

/** The releases a tick will act on. The other statuses are waiting or over. */
const ACTIVE_STATUS = "running";

/** How many sends run at once inside one slice. */
const SEND_CONCURRENCY = 8;

/**
 * Only one tick runs at a time, in this process, for all releases.
 *
 * The guard is here rather than in a caller because the callers are plural —
 * the interval, the backstop route, a hand-run — and a guard held by one of
 * them cannot see the others. Postgres protects a row from two PROCESSES; this
 * protects the service from stacking ticks when one runs long.
 */
let tickInFlight = false;

/** Set on shutdown so an in-flight tick stops claiming new work. */
let stopping = false;

let timer: NodeJS.Timeout | null = null;

export interface TickReport {
  releasesConsidered: number;
  sent: number;
  failed: number;
  skippedOptedOut: number;
  completed: string[];
  halted: string[];
  /** True when another tick was already running and this call did nothing. */
  skippedBusy: boolean;
}

const EMPTY_REPORT = (): TickReport => ({
  releasesConsidered: 0,
  sent: 0,
  failed: 0,
  skippedOptedOut: 0,
  completed: [],
  halted: [],
  skippedBusy: false,
});

function headersOf(release: MailingListRelease): Record<string, string | undefined> {
  return {
    "x-org-id": release.orgId,
    "x-user-id": release.userId,
    "x-brand-id": release.brandIds?.join(","),
    "x-campaign-id": release.campaignId ?? undefined,
    "x-workflow-slug": release.workflowSlug ?? undefined,
    "x-feature-slug": release.featureSlug ?? undefined,
    "x-audience-id": release.audienceId ?? undefined,
  };
}

function workflowHeadersOf(release: MailingListRelease) {
  return {
    campaignId: release.campaignId ?? undefined,
    brandId: release.brandIds?.join(","),
    workflowSlug: release.workflowSlug ?? undefined,
    featureSlug: release.featureSlug ?? undefined,
    audienceId: release.audienceId ?? undefined,
  };
}

export interface ReleaseProgress {
  reached: number;
  failed: number;
  skippedOptedOut: number;
  inFlight: number;
  remaining: number;
  todayUsed: number;
}

/**
 * Where a release stands, counted from the ledger rather than held in memory,
 * so a redeploy changes nothing about the answer.
 */
export async function readProgress(releaseId: string, now = new Date()): Promise<ReleaseProgress> {
  const dayStart = startOfUtcDay(now);

  const rows = await db.execute(raw`
    SELECT
      count(*) FILTER (WHERE status = 'sent') AS reached,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status = 'skipped_opted_out') AS skipped,
      count(*) FILTER (WHERE status = 'sending') AS in_flight,
      count(*) FILTER (WHERE status = 'pending') AS remaining,
      count(*) FILTER (WHERE status IN ('sent', 'failed') AND settled_at >= ${dayStart.toISOString()}::timestamptz) AS today_used
    FROM mailing_list_release_recipients
    WHERE release_id = ${releaseId}
  `);

  const row = (rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
  const num = (key: string) => Number(row[key] ?? 0);

  // An address a worker is holding right now has already been taken out of the
  // day's allowance, so it counts as used. Reporting otherwise would let a
  // second tick spend the same allowance twice.
  const inFlight = num("in_flight");

  return {
    reached: num("reached"),
    failed: num("failed"),
    skippedOptedOut: num("skipped"),
    inFlight,
    remaining: num("remaining"),
    todayUsed: num("today_used") + inFlight,
  };
}

/**
 * Settle claims that outlived the worker holding them.
 *
 * They are marked failed with a reason saying so, never returned to pending.
 * Returning them would be the only way to guarantee everyone is reached, and it
 * would cost the guarantee that nobody is reached twice — which is the one that
 * matters at thirty thousand addresses, and the one the provider's complaint
 * threshold punishes.
 */
async function settleStaleClaims(releaseId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - CLAIM_STALE_MS);
  const settled = await db
    .update(mailingListReleaseRecipients)
    .set({ status: "failed", reason: INTERRUPTED_REASON, settledAt: now })
    .where(
      and(
        eq(mailingListReleaseRecipients.releaseId, releaseId),
        eq(mailingListReleaseRecipients.status, "sending"),
        raw`${mailingListReleaseRecipients.claimedAt} < ${cutoff.toISOString()}::timestamptz`
      )
    )
    .returning({ id: mailingListReleaseRecipients.id });

  if (settled.length > 0) {
    console.warn(
      `[transactional-email-service] release ${releaseId}: ${settled.length} claim(s) outlived their worker and were settled as failed`
    );
  }
  return settled.length;
}

/**
 * Take up to `limit` addresses out of the pending queue for this release.
 *
 * `FOR UPDATE SKIP LOCKED` inside an UPDATE that only matches `pending` is what
 * makes two concurrent ticks — in this process or another — split the queue
 * rather than duplicate it.
 */
async function claimSlice(releaseId: string, limit: number): Promise<Array<{ id: string; email: string }>> {
  if (limit <= 0) return [];

  const rows = await db.execute(raw`
    UPDATE mailing_list_release_recipients
    SET status = 'sending', claimed_at = now()
    WHERE id IN (
      SELECT id FROM mailing_list_release_recipients
      WHERE release_id = ${releaseId} AND status = 'pending'
      ORDER BY email
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, email
  `);

  return (rows as unknown as Array<{ id: string; email: string }>).map((r) => ({ id: r.id, email: r.email }));
}

async function settle(ids: string[], status: string, reason: string | null, now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(mailingListReleaseRecipients)
    .set({ status, reason, settledAt: now })
    .where(inArray(mailingListReleaseRecipients.id, ids));
}

/**
 * Tell staff a release stopped itself.
 *
 * Sent to the same hardcoded staff list `/send` routes its alerts to, from the
 * template this repo owns and upserts at boot. It fails loud — a halt nobody is
 * told about is most of the problem — but it is raised after the release has
 * already been marked halted, so a failure to send the alert cannot leave the
 * release running.
 */
async function alertStaff(release: MailingListRelease, slug: string, reason: string, reached: number): Promise<void> {
  const template = await getTemplate("mailing_list_release_halted");
  const rendered = template({
    subject: release.subject,
    slug,
    reason,
    reached,
    recipientCount: release.recipientCount,
    releaseId: release.id,
  });

  for (const email of ADMIN_EMAILS) {
    await sendEmail({
      to: email,
      subject: rendered.subject,
      htmlBody: rendered.htmlBody,
      textBody: rendered.textBody,
      tag: "mailing-list-release-halted",
      orgId: release.orgId,
      userId: release.userId,
      runId: release.runId,
      from: rendered.from,
      workflowHeaders: workflowHeadersOf(release),
    });
  }
}

/**
 * Read this release's delivery outcomes back from the provider and stop the
 * release if they have gone bad.
 *
 * A probe that cannot be answered decides nothing: it is logged and asked again
 * on the next tick. Turning an unanswerable question into "healthy" is the
 * failure this feature exists to prevent, and turning it into "halt" would stop
 * every release the first time email-gateway restarted.
 */
async function checkHealth(release: MailingListRelease, slug: string, now: Date): Promise<boolean> {
  const progress = await readProgress(release.id, now);
  if (progress.reached < HEALTH_MIN_SAMPLE) return false;

  const last = release.lastHealthCheckAt?.getTime() ?? 0;
  if (now.getTime() - last < HEALTH_CHECK_INTERVAL_MS) return false;

  let outcomes;
  try {
    outcomes = await fetchDeliveryOutcomes(release.runId);
  } catch (err: any) {
    console.error(
      `[transactional-email-service] release ${release.id}: delivery outcomes unavailable, no verdict this tick: ${err.message}`
    );
    return false;
  }

  // The ledger says this release has reached hundreds of people and the
  // provider says it sent nobody. Those cannot both be true, so this is not a
  // healthy release — it is a release whose outcomes this service cannot see,
  // and reading it as healthy would make the whole self-halt quietly inert.
  //
  // It is the live state as of v0.22.0: every message carries the release's run
  // id, but the gateway mints a CHILD run per send and records that against the
  // message, so a query keyed on the release's own run matches nothing. Neither
  // `/public/stats` nor the status routes filter on a parent run or on a tag,
  // and enumerating tens of thousands of child runs per probe is not a query.
  // Tracked in email-gateway and postmark-service; the fix is a `tag` filter,
  // which every message already carries (see the tag set in releaseSlice).
  //
  // Loud and repeatedly, rather than once: a staff member reading the logs of a
  // release in flight must find this, and nothing here decides anything from an
  // answer it knows to be blind.
  if (outcomes.sent === 0 && progress.reached >= HEALTH_MIN_SAMPLE) {
    console.error(
      `[transactional-email-service] release ${release.id}: the ledger has reached ${progress.reached} addresses ` +
        `and the provider reports 0 sent for this run, so its delivery outcomes are NOT VISIBLE and this release ` +
        `cannot stop itself. Watch it by hand, by the tag mailing-list-release-${release.id}.`
    );
    traceEvent(
      release.runId,
      {
        service: "transactional-email-service",
        event: "mailing-list-release-outcomes-blind",
        detail: `Reached ${progress.reached}, provider reports 0 sent for this run: outcomes not visible, self-halt inert`,
        level: "error",
      },
      headersOf(release)
    );
    return false;
  }

  const verdict = assessOutcomes(outcomes);

  await db
    .update(mailingListReleases)
    .set({ lastHealthCheckAt: now, updatedAt: now })
    .where(eq(mailingListReleases.id, release.id));

  if (!verdict.halt) return false;

  await db
    .update(mailingListReleases)
    .set({ status: "halted", haltedReason: verdict.reason, updatedAt: now })
    .where(eq(mailingListReleases.id, release.id));

  console.warn(`[transactional-email-service] release ${release.id} halted itself: ${verdict.reason}`);
  traceEvent(
    release.runId,
    {
      service: "transactional-email-service",
      event: "mailing-list-release-halted",
      detail: verdict.reason ?? "halted",
      level: "error",
    },
    headersOf(release)
  );

  await alertStaff(release, slug, verdict.reason!, progress.reached);
  return true;
}

/**
 * Send one slice of one release.
 *
 * The suppression read carries `maxAgeMs: 0` — this slice asks the provider
 * about its own addresses now, and never reuses an answer a page load or an
 * earlier slice cached. That is the whole of requirement seven: somebody who
 * unsubscribed on day one is a skip on day five rather than a second email.
 */
async function releaseSlice(
  release: MailingListRelease,
  slug: string,
  slice: Array<{ id: string; email: string }>,
  report: TickReport,
  now: Date
): Promise<void> {
  const suppression = await fetchSuppressed(
    { orgId: release.orgId, userId: release.userId },
    "/mailing-lists/:slug/releases",
    slice.map((r) => r.email),
    { maxAgeMs: 0 }
  );

  const suppressed = slice.filter((r) => suppression.isSuppressed(r.email));
  for (const row of suppressed) {
    await settle([row.id], "skipped_opted_out", suppression.reasonFor(row.email), now);
  }
  report.skippedOptedOut += suppressed.length;

  const sendable = slice.filter((r) => !suppression.isSuppressed(r.email));

  for (let offset = 0; offset < sendable.length; offset += SEND_CONCURRENCY) {
    const wave = sendable.slice(offset, offset + SEND_CONCURRENCY);
    const outcomes = await Promise.all(
      wave.map(async (row) => {
        try {
          await sendEmail({
            to: row.email,
            subject: release.subject,
            htmlBody: release.htmlBody,
            textBody: release.textBody,
            // Per release, not per list. The provider stores the tag on every
            // message, so this is the one handle that identifies exactly this
            // release's mail in the Postmark archive — and it is what a
            // by-tag outcomes filter would key on once the gateway offers one
            // (see checkHealth).
            tag: `mailing-list-release-${release.id}`,
            orgId: release.orgId,
            userId: release.userId,
            runId: release.runId,
            from: release.fromAddress,
            workflowHeaders: workflowHeadersOf(release),
          });
          return { id: row.id, reason: null as string | null };
        } catch (err: any) {
          return { id: row.id, reason: err.message || "Unknown send error" };
        }
      })
    );

    const settledAt = new Date();
    const sentIds = outcomes.filter((o) => o.reason === null).map((o) => o.id);
    await settle(sentIds, "sent", null, settledAt);
    report.sent += sentIds.length;

    for (const failure of outcomes.filter((o) => o.reason !== null)) {
      await settle([failure.id], "failed", failure.reason, settledAt);
      report.failed += 1;
    }
  }
}

/** Mark a release finished once no address is still waiting or in flight. */
async function completeIfDone(release: MailingListRelease, report: TickReport, now: Date): Promise<void> {
  const progress = await readProgress(release.id, now);
  if (progress.remaining > 0 || progress.inFlight > 0) return;

  await db
    .update(mailingListReleases)
    .set({ status: "completed", completedAt: now, updatedAt: now })
    .where(and(eq(mailingListReleases.id, release.id), eq(mailingListReleases.status, ACTIVE_STATUS)));

  report.completed.push(release.id);

  traceEvent(
    release.runId,
    {
      service: "transactional-email-service",
      event: "mailing-list-release-done",
      detail: `'${release.subject}' reached ${progress.reached} of ${release.recipientCount}; ${progress.failed} failed, ${progress.skippedOptedOut} opted out`,
      ...(progress.failed > 0 ? { level: "error" as const } : {}),
    },
    headersOf(release)
  );

  await updateRun(
    release.runId,
    progress.reached > 0 ? "completed" : "failed",
    { orgId: release.orgId, userId: release.userId },
    workflowHeadersOf(release)
  );
}

/**
 * One pass over every running release.
 *
 * Cheap when there is nothing to do: a single indexed read returning no rows,
 * which is what almost every tick is. That matters because the interval is
 * short by design, and a short interval that does expensive work on an idle
 * system is how a pacing mechanism becomes a load problem.
 */
export async function runReleaseTick(now = new Date()): Promise<TickReport> {
  if (tickInFlight) return { ...EMPTY_REPORT(), skippedBusy: true };
  tickInFlight = true;

  const report = EMPTY_REPORT();

  try {
    const active = await db
      .select({ release: mailingListReleases, slug: mailingLists.slug })
      .from(mailingListReleases)
      .innerJoin(mailingLists, eq(mailingLists.id, mailingListReleases.listId))
      .where(eq(mailingListReleases.status, ACTIVE_STATUS));

    report.releasesConsidered = active.length;

    for (const { release, slug } of active) {
      if (stopping) break;

      try {
        await settleStaleClaims(release.id, now);

        if (await checkHealth(release, slug, now)) {
          report.halted.push(release.id);
          continue;
        }

        const progress = await readProgress(release.id, now);

        if (progress.remaining === 0 && progress.inFlight === 0) {
          await completeIfDone(release, report, now);
          continue;
        }

        const allowance = tickAllowance({
          dailyLimit: release.dailyLimit,
          sentToday: progress.todayUsed,
          now,
        });

        const slice = await claimSlice(release.id, Math.min(allowance, progress.remaining));
        if (slice.length === 0) continue;

        await releaseSlice(release, slug, slice, report, now);
        await completeIfDone(release, report, now);
      } catch (err: any) {
        // One release's bad day is not another's. Log it and carry on: the next
        // tick retries, and nothing has been claimed that a stale-claim sweep
        // will not account for.
        console.error(`[transactional-email-service] release ${release.id} tick failed: ${err.message}`);
      }
    }
  } finally {
    tickInFlight = false;
  }

  return report;
}

/**
 * Arm the worker. Called after the port is bound, never before: nothing here
 * may stand between boot and the service answering its health check, and the
 * first tick's cost is unrelated to the size of any list.
 */
export function startReleaseWorker(intervalMs = WORKER_INTERVAL_MS): void {
  if (timer) return;
  stopping = false;
  timer = setInterval(() => {
    runReleaseTick().catch((err) => {
      console.error("[transactional-email-service] release tick threw:", err);
    });
  }, intervalMs);
  // Nothing about a release should keep the process alive on its own.
  timer.unref();
  console.log(`[transactional-email-service] mailing-list release worker armed, every ${intervalMs}ms`);
}

/**
 * Stop claiming new work and let the slice in flight finish.
 *
 * A redeploy sends SIGTERM, so a planned restart settles what it claimed and
 * loses nobody. An unplanned kill cannot, which is what the stale-claim sweep
 * accounts for.
 */
export async function stopReleaseWorker(): Promise<void> {
  stopping = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const deadline = Date.now() + 30_000;
  while (tickInFlight && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Test seam: forget that a tick is running. */
export function resetReleaseWorkerState(): void {
  tickInFlight = false;
  stopping = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
