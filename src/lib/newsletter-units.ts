/**
 * EVERY NEWSLETTER EMAIL IS A UNIT (OUTCOME-FINEST-1106, owner 2026-11-06).
 *
 * « le QUOI c'est l'outcome, et il doit être toujours aussi fin que possible »: a
 * newsletter is not a post and not a cold email. Each email a mailing-list release
 * sends to one subscriber is ONE occurrence of its own outcome, `newsletter_email_sent`
 * (features-service catalogue step, subject kind object: the email), so a release
 * reads like any other outcome of the factory: Units, what they cost, what they led to.
 *
 * WHERE: on one spend-free run per release (`units_run_id`), a CHILD of the release's
 * own run, on the release's org (the org the release was created under, which already
 * pays every send and every verification of it: nothing here is platform-billed). One
 * run = one produced outcome key: the release run itself already produces the
 * `message_sent` of the sends made before 2026-10-23 (outcome-backfill.ts), so the Units
 * cannot go there.
 *
 * WHAT each Unit says:
 *   - produced `newsletter_email_sent`, subject = the recipient row (`mailing_list_release_recipients.id`):
 *     one per release x subscriber, so a later click names THIS email and no other release's.
 *   - consumed `message_sent`, subject = the subscriber (outcome-subject.ts): the send it is made of,
 *     declared by postmark-service on the send's run (before 2026-10-23: by our backfill on the release run).
 *     The Unit's cost is that send's standard cost (and, through it, the `email_checked` it consumed).
 *     An address no longer on the list consumes nothing (the send named nobody either).
 *   - consumed `newsletter_validated`, subject = the release's draft (NEWSLETTER-OUTCOMES-1107, newsletter-drafts.ts):
 *     the owner's go the emails were sent on, once per call (runs-service keeps one occurrence per run). A release made
 *     from no draft (a test, every release before 2026-11-07) consumes no validation.
 *   - `occurredAt` = the send's own instant, so consumption resolution picks this send's `message_sent`.
 *
 * WHAT IT LED TO: every link to our sites in the email carries `dy_unit=<outcome>:<subjectService>:<subjectId>`
 * (`unitLinkValue`), the Unit itself, beside the subscriber's `dy_sub`. The capture script on our sites strips only
 * `dy_sub`, so the visit's entry URL keeps `dy_unit`: whoever credits website visits can declare the visit as
 * consuming this exact Unit (a click on its link, never a time window).
 *
 * WHEN: a background pass (first ~60 s after boot, then every minute, in-function mutex) declares every sent row not
 * declared yet, oldest first, so a live send lands within a minute and every past send since the first release is
 * declared by the same path. Idempotent at runs-service (a replay is `already_recorded`); a call that fails stops the
 * pass and the rows stay undeclared for the next one (loud, never forced).
 */
import { and, inArray, isNull, sql as raw } from "drizzle-orm";
import { db } from "../db/index.js";
import { mailingListReleaseRecipients, mailingListReleases } from "../db/schema.js";
import { messageOf } from "./db-error.js";
import { createRun, updateRun } from "./runs-client.js";
import { declareRunOutcomes, type OutcomeOccurrence } from "./run-outcomes.js";
import { SUBJECT_SERVICE, subscriberSubject } from "./outcome-subject.js";
import { validatedSubject } from "./newsletter-drafts.js";

/** The catalogue step every newsletter email is a Unit of. */
export const NEWSLETTER_EMAIL_SENT = "newsletter_email_sent";
/** What a newsletter email consumes: its send (postmark-service's occurrence). */
export const NEWSLETTER_EMAIL_CONSUMES = "message_sent";
/** The link parameter naming the Unit a click came from. */
export const UNIT_LINK_PARAM = "dy_unit";
export const UNITS_TASK = "newsletter-email-units";

/**
 * runs-service's ceiling per call is 1000 occurrences; a Unit states at most 2 (produced + consumed) and a call from a
 * drafted release adds ONE consumed `newsletter_validated`: 2 x 499 + 1 = 999.
 */
export const MAX_UNITS_PER_CALL = 499;
/** Rows read per pass: bounds one pass's work (the backlog drains over a few passes). */
export const MAX_UNITS_PER_PASS = 5000;
export const UNITS_INTERVAL_MS = 60_000;
const FIRST_PASS_DELAY_MS = 60_000;

/** The Unit a release email is: its recipient row. */
export function unitSubject(recipientId: string): OutcomeOccurrence {
  return { outcomeKey: NEWSLETTER_EMAIL_SENT, subjectService: SUBJECT_SERVICE, subjectId: recipientId };
}

/** `dy_unit`'s value: the Unit's outcome, subject service and subject id. URL-safe as is. */
export function unitLinkValue(recipientId: string): string {
  return `${NEWSLETTER_EMAIL_SENT}:${SUBJECT_SERVICE}:${recipientId}`;
}

export interface SentUnit {
  recipientId: string;
  releaseId: string;
  /** The subscriber the send named, or null (address no longer on the list). */
  subscriberId: string | null;
  /** The draft the release sends (its validation), or null. */
  draftId: string | null;
  settledAt: Date;
}

export interface UnitCall {
  releaseId: string;
  occurredAt: string;
  recipientIds: string[];
  produced: OutcomeOccurrence[];
  consumed: OutcomeOccurrence[];
}

/**
 * PURE. One call per (release, send instant), at most MAX_UNITS_PER_CALL Units: one `occurredAt` per call, and a
 * wave of sends settles under one instant. Deterministic (release, instant, recipient), so a re-run cuts the same calls.
 */
export function planUnitCalls(units: readonly SentUnit[]): UnitCall[] {
  const sorted = [...units].sort(
    (a, b) =>
      a.releaseId.localeCompare(b.releaseId) ||
      a.settledAt.getTime() - b.settledAt.getTime() ||
      a.recipientId.localeCompare(b.recipientId)
  );
  const calls: UnitCall[] = [];
  let current: UnitCall | null = null;
  for (const u of sorted) {
    const at = u.settledAt.toISOString();
    if (!current || current.releaseId !== u.releaseId || current.occurredAt !== at || current.recipientIds.length >= MAX_UNITS_PER_CALL) {
      current = { releaseId: u.releaseId, occurredAt: at, recipientIds: [], produced: [], consumed: [] };
      if (u.draftId) current.consumed.push(validatedSubject(u.draftId));
      calls.push(current);
    }
    current.recipientIds.push(u.recipientId);
    current.produced.push(unitSubject(u.recipientId));
    if (u.subscriberId) current.consumed.push({ outcomeKey: NEWSLETTER_EMAIL_CONSUMES, ...subscriberSubject(u.subscriberId) });
  }
  return calls;
}

/** Sent emails whose Unit is not declared yet, oldest first (the partial index's predicate, verbatim). */
export async function readUndeclaredUnits(limit = MAX_UNITS_PER_PASS): Promise<SentUnit[]> {
  const rows = (await db.execute(raw`
    SELECT x.id::text AS recipient_id, x.release_id::text AS release_id, s.id::text AS subscriber_id, r.draft_id::text AS draft_id, x.settled_at
      FROM mailing_list_release_recipients x
      JOIN mailing_list_releases r ON r.id = x.release_id
      LEFT JOIN mailing_list_subscribers s ON s.list_id = r.list_id AND s.email = x.email
     WHERE x.status = 'sent' AND x.unit_declared_at IS NULL
     ORDER BY x.settled_at, x.id
     LIMIT ${limit}
  `)) as unknown as Array<{ recipient_id: string; release_id: string; subscriber_id: string | null; draft_id: string | null; settled_at: Date | string | null }>;
  return rows
    .filter((r) => r.settled_at !== null)
    .map((r) => ({
      recipientId: r.recipient_id,
      releaseId: r.release_id,
      subscriberId: r.subscriber_id,
      draftId: r.draft_id,
      settledAt: new Date(r.settled_at as Date | string),
    }));
}

interface ReleaseIdentity {
  id: string;
  orgId: string;
  userId: string;
  runId: string;
  unitsRunId: string | null;
  brandIds: string[] | null;
  campaignId: string | null;
  workflowSlug: string | null;
  featureSlug: string | null;
  audienceId: string | null;
}

async function readReleases(ids: string[]): Promise<Map<string, ReleaseIdentity>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: mailingListReleases.id,
      orgId: mailingListReleases.orgId,
      userId: mailingListReleases.userId,
      runId: mailingListReleases.runId,
      unitsRunId: mailingListReleases.unitsRunId,
      brandIds: mailingListReleases.brandIds,
      campaignId: mailingListReleases.campaignId,
      workflowSlug: mailingListReleases.workflowSlug,
      featureSlug: mailingListReleases.featureSlug,
      audienceId: mailingListReleases.audienceId,
    })
    .from(mailingListReleases)
    .where(inArray(mailingListReleases.id, ids));
  return new Map(rows.map((r) => [r.id, { ...r }]));
}

/**
 * The release's Units run, opened once: a child of the release's run on the release's org, closed `completed` at once
 * (it spends nothing; it only states the Units). A concurrent opener keeps the first id stored.
 */
async function ensureUnitsRun(release: ReleaseIdentity): Promise<string> {
  if (release.unitsRunId) return release.unitsRunId;
  const workflowHeaders = {
    campaignId: release.campaignId ?? undefined,
    brandId: release.brandIds?.join(",") || undefined,
    workflowSlug: release.workflowSlug ?? undefined,
    featureSlug: release.featureSlug ?? undefined,
    audienceId: release.audienceId ?? undefined,
  };
  const run = await createRun({
    orgId: release.orgId,
    userId: release.userId,
    serviceName: SUBJECT_SERVICE,
    taskName: UNITS_TASK,
    parentRunId: release.runId,
    ...(release.brandIds?.length ? { brandIds: release.brandIds } : {}),
    ...(release.campaignId ? { campaignId: release.campaignId } : {}),
    workflowHeaders,
  });
  await updateRun(run.id, "completed", { orgId: release.orgId, userId: release.userId }, workflowHeaders);
  const stored = (await db.execute(raw`
    UPDATE mailing_list_releases SET units_run_id = ${run.id}::uuid WHERE id = ${release.id}::uuid AND units_run_id IS NULL
    RETURNING units_run_id::text AS units_run_id
  `)) as unknown as Array<{ units_run_id: string }>;
  if (stored[0]) {
    release.unitsRunId = stored[0].units_run_id;
    return release.unitsRunId;
  }
  const [kept] = (await db.execute(raw`
    SELECT units_run_id::text AS units_run_id FROM mailing_list_releases WHERE id = ${release.id}::uuid
  `)) as unknown as Array<{ units_run_id: string }>;
  release.unitsRunId = kept.units_run_id;
  return release.unitsRunId;
}

export interface UnitsPassReport {
  units: number;
  calls: number;
  declared: number;
  recorded: number;
  alreadyRecorded: number;
  unitsRunsOpened: number;
  /** The failure that stopped this pass (its rows stay undeclared for the next one). */
  error: string | null;
}

let inFlight: Promise<UnitsPassReport> | null = null;

/** One pass. Concurrent callers join the pass in flight. */
export function declareNewsletterUnits(limit = MAX_UNITS_PER_PASS): Promise<UnitsPassReport> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const report: UnitsPassReport = { units: 0, calls: 0, declared: 0, recorded: 0, alreadyRecorded: 0, unitsRunsOpened: 0, error: null };
    const units = await readUndeclaredUnits(limit);
    report.units = units.length;
    if (units.length === 0) return report;
    const releases = await readReleases([...new Set(units.map((u) => u.releaseId))]);
    for (const call of planUnitCalls(units)) {
      const release = releases.get(call.releaseId);
      if (!release) continue; // deleted between the two reads: nothing to declare on
      try {
        const opened = !release.unitsRunId;
        const runId = await ensureUnitsRun(release);
        if (opened) report.unitsRunsOpened++;
        const result = await declareRunOutcomes(
          runId,
          { orgId: release.orgId, userId: release.userId },
          { produced: call.produced, ...(call.consumed.length > 0 ? { consumed: call.consumed } : {}), occurredAt: call.occurredAt }
        );
        await db
          .update(mailingListReleaseRecipients)
          .set({ unitDeclaredAt: new Date() })
          .where(and(inArray(mailingListReleaseRecipients.id, call.recipientIds), isNull(mailingListReleaseRecipients.unitDeclaredAt)));
        report.calls++;
        report.declared += call.recipientIds.length;
        report.recorded += result.recordedCount;
        report.alreadyRecorded += result.alreadyRecordedCount;
      } catch (err) {
        report.error = `release ${call.releaseId} (${call.recipientIds.length} email(s) sent ${call.occurredAt}): ${messageOf(err)}`;
        console.error(`[transactional-email-service] newsletter Units NOT declared, asked again next pass: ${report.error}`);
        break;
      }
    }
    if (report.declared > 0) console.log(`[transactional-email-service] newsletter Units pass ${JSON.stringify(report)}`);
    return report;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let timers: NodeJS.Timeout[] = [];

/** First pass ~60 s after boot, then every minute. */
export function startNewsletterUnitsWorker(): void {
  if (timers.length > 0) return;
  const tick = () => {
    declareNewsletterUnits().catch((err) => console.error("[transactional-email-service] newsletter Units pass failed:", err));
  };
  const first = setTimeout(tick, FIRST_PASS_DELAY_MS);
  const every = setInterval(tick, UNITS_INTERVAL_MS);
  first.unref();
  every.unref();
  timers = [first, every];
}

export function stopNewsletterUnitsWorker(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}
