/**
 * COST-BACKFILL-1023 (owner 2026-10-23, « pour être à 100 % now »): the release
 * sends made BEFORE the live declarations (outcome-subject.ts) paid for outcomes
 * too, and our own rows say which. This module re-reads them and declares, on
 * each release's own run, one `message_sent` per subscriber it reached, through
 * runs-service's batch backfill door with the send's own instant as
 * `occurredAt` — so it behaves as if declared when the message left.
 *
 * Why the release run and not the child runs that spent: those belong to
 * postmark-service (`email-send`) and apollo-service (`verify-email*`), and before
 * the live path neither knew the subscriber. apollo-service's own backfill skips
 * every mailing-list verification on purpose ("transactional-email-service
 * declares on its own run, ours rolls into it"). A run's cost is its own cost
 * rows + those of every descendant that declares nothing, so the release run's
 * `message_sent` occurrences carry the past sends AND the past verifications:
 * a rejected address's check rides the kept ones (normal loss), and nothing is
 * declared as consumed (no produced `email_checked` exists for a past check, and
 * an unknown-provenance consumption would charge the check a second time).
 *
 * Which sends: status `sent` settled before LIVE_SUBJECTS_SINCE, the instant the
 * build that names the subscriber on every send went live in prod. From then on
 * postmark-service declares `message_sent` (and apollo-service `email_checked`)
 * on the child runs; declaring those again here would count each send twice.
 * A recipient whose address left the list since has no subscriber row and names
 * nobody, exactly like the live path.
 *
 * Idempotent: runs-service records an occurrence once (run, key, subject), so a
 * re-run answers `already_recorded` and writes nothing. Resumable: a call that
 * fails throws, and the next run re-sends everything, recorded or not.
 */
import { sql } from "../db/index.js";
import { declareOutcomesBatch } from "./runs-client.js";
import { SUBJECT_SERVICE } from "./outcome-subject.js";

/**
 * When transactional-email-service v0.25.23 (PR #231, subscriber named on every
 * release send) started in prod: the container's StartedAt. Every send settled
 * after it was declared live by postmark-service (724 sends vs 721 live
 * `message_sent` occurrences at 2026-10-23 18:10Z, the rest still in flight).
 */
export const LIVE_SUBJECTS_SINCE = new Date("2026-10-23T14:33:24.593Z");

/** runs-service's per-call ceiling (POST /v1/platform-runs/outcomes/batch). */
export const MAX_OCCURRENCES_PER_CALL = 1000;

export interface PastSend {
  runId: string;
  subscriberId: string;
  settledAt: Date;
}

export interface BackfillCall {
  runId: string;
  occurredAt: string;
  subscriberIds: string[];
}

/**
 * One call per (release run, UTC day of the send), at most
 * MAX_OCCURRENCES_PER_CALL subscribers, stamped with its earliest send: every
 * occurrence counts on the day its message left. Deterministic (ordered by
 * run, instant, subscriber), so a re-run cuts the same calls.
 */
export function planBackfillCalls(sends: PastSend[]): BackfillCall[] {
  const sorted = [...sends].sort(
    (a, b) =>
      a.runId.localeCompare(b.runId) ||
      a.settledAt.getTime() - b.settledAt.getTime() ||
      a.subscriberId.localeCompare(b.subscriberId)
  );
  const calls: BackfillCall[] = [];
  let current: (BackfillCall & { day: string }) | null = null;
  for (const send of sorted) {
    const day = send.settledAt.toISOString().slice(0, 10);
    if (!current || current.runId !== send.runId || current.day !== day || current.subscriberIds.length >= MAX_OCCURRENCES_PER_CALL) {
      current = { runId: send.runId, day, occurredAt: send.settledAt.toISOString(), subscriberIds: [] };
      calls.push(current);
    }
    current.subscriberIds.push(send.subscriberId);
  }
  return calls.map(({ runId, occurredAt, subscriberIds }) => ({ runId, occurredAt, subscriberIds }));
}

/** Every past release send our rows hold, one per (release run, subscriber). */
export async function readPastReleaseSends(): Promise<PastSend[]> {
  const rows = await sql<Array<{ run_id: string; subscriber_id: string; settled_at: Date }>>`
    SELECT r.run_id::text AS run_id, s.id::text AS subscriber_id, min(x.settled_at) AS settled_at
      FROM mailing_list_release_recipients x
      JOIN mailing_list_releases r ON r.id = x.release_id
      JOIN mailing_list_subscribers s ON s.list_id = r.list_id AND s.email = x.email
     WHERE x.status = 'sent'
       AND x.settled_at IS NOT NULL
       AND x.settled_at < ${LIVE_SUBJECTS_SINCE.toISOString()}::timestamptz
     GROUP BY r.run_id, s.id`;
  return rows.map((r) => ({ runId: r.run_id, subscriberId: r.subscriber_id, settledAt: new Date(r.settled_at) }));
}

export interface BackfillReport {
  dryRun: boolean;
  releaseRuns: number;
  occurrences: number;
  calls: number;
  recorded: number;
  alreadyRecorded: number;
}

export async function backfillReleaseOutcomes(opts: { dryRun: boolean }): Promise<BackfillReport> {
  const sends = await readPastReleaseSends();
  const calls = planBackfillCalls(sends);
  const report: BackfillReport = {
    dryRun: opts.dryRun,
    releaseRuns: new Set(sends.map((s) => s.runId)).size,
    occurrences: sends.length,
    calls: calls.length,
    recorded: 0,
    alreadyRecorded: 0,
  };
  if (opts.dryRun) return report;

  for (const call of calls) {
    const result = await declareOutcomesBatch({
      runs: [
        {
          runId: call.runId,
          occurredAt: call.occurredAt,
          produced: call.subscriberIds.map((subjectId) => ({
            outcomeKey: "message_sent",
            subjectService: SUBJECT_SERVICE,
            subjectId,
          })),
        },
      ],
    });
    report.recorded += result.recordedCount;
    report.alreadyRecorded += result.alreadyRecordedCount;
  }
  console.log(`[transactional-email-service] outcome backfill: ${JSON.stringify(report)}`);
  return report;
}
