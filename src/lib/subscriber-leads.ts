/**
 * LEDGER-HISTORY-1024: a subscriber who is also a lead-service lead is ONE
 * subject in the runs-service ledger.
 *
 * A newsletter address is checked once (apollo-service, `email_checked` on the
 * subscriber). When instantly-service later mails the same person as a LEAD, it
 * consumes `email_checked` on the lead — and the check that produced it sits
 * under the subscriber. Declaring the check twice would double count it, so we,
 * the owner of the subscriber subject, state on runs-service's door that
 * subscriber S is the same subject as lead L: one check, consumed under both.
 *
 * Which lead an address is comes from lead-service only (`POST
 * /internal/leads/ids/by-email`, org-free: one registered email = one lead
 * fleet-wide). `not_a_lead` and `ambiguous` state nothing (never a pick); a
 * subscriber who becomes a lead later is stated on a later pass. Every
 * subscriber row is stated on its own, so an address on two lists gives two
 * equivalences to the same lead.
 *
 * Past AND forward: the same pass runs on demand (`POST
 * /internal/ledger-subjects/leads`) and on an in-process interval
 * (startSubscriberLeadSweep). Stateless: runs-service rows are immutable and a
 * replay answers `already_recorded`, so each pass re-sends every resolved
 * subscriber. A call refused by runs-service (422, all or nothing) is retried
 * without the refused items, which are reported by subscriber + reason and
 * never forced. Any other failure throws.
 *
 * Own module because the worker's integration tests `vi.mock` whole modules.
 */
import { sql } from "../db/index.js";
import { SUBJECT_SERVICE } from "./outcome-subject.js";
import { EquivalencesRefusedError, stateSubjectEquivalences, type SubjectEquivalence } from "./runs-client.js";

export const LEAD_SUBJECT_SERVICE = "lead-service";
/** lead-service's per-call ceiling on POST /internal/leads/ids/by-email. */
export const RESOLVE_CHUNK = 1000;
/** runs-service's per-call ceiling on POST /v1/platform-runs/subject-equivalences. */
export const EQUIVALENCE_CHUNK = 1000;
export const EQUIVALENCE_REASON =
  "A mailing-list subscriber whose address is a lead-service lead is the same person: one email_checked, consumed under both (LEDGER-HISTORY-1024).";
export const STATED_BY = "transactional-email-service:subscriber-lead-sweep";

export interface LeadAnswer {
  email: string;
  leadId: string | null;
  reason: null | "not_a_lead" | "ambiguous";
}

function leadConfig(): { url: string; apiKey: string } {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL and LEAD_SERVICE_API_KEY must be set");
  return { url, apiKey };
}

/** One answer per address asked, from lead-service. Throws on any refusal or malformed answer. */
export async function resolveLeadsByEmail(emails: string[]): Promise<Map<string, LeadAnswer>> {
  const { url, apiKey } = leadConfig();
  const byEmail = new Map<string, LeadAnswer>();
  for (let offset = 0; offset < emails.length; offset += RESOLVE_CHUNK) {
    const chunk = emails.slice(offset, offset + RESOLVE_CHUNK);
    const response = await fetch(`${url}/internal/leads/ids/by-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ emails: chunk }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`lead-service POST /internal/leads/ids/by-email ${response.status}: ${text.slice(0, 500)}`);
    const body = JSON.parse(text) as { answers?: LeadAnswer[] };
    if (!Array.isArray(body.answers) || body.answers.length !== chunk.length) {
      throw new Error(`lead-service answered ${body.answers?.length ?? "no"} answers for ${chunk.length} addresses`);
    }
    body.answers.forEach((a, i) => byEmail.set(chunk[i].toLowerCase(), a));
  }
  return byEmail;
}

export interface SubscriberLeadsReport {
  dryRun: boolean;
  subscribers: number;
  resolved: number;
  notALead: number;
  ambiguous: number;
  recorded: number;
  alreadyRecorded: number;
  refused: Array<{ subscriberId: string; leadId: string; reason: string }>;
}

/** Sends one chunk; on a 422 drops the refused items, reports them, and sends the rest. */
async function stateChunk(items: SubjectEquivalence[], report: SubscriberLeadsReport): Promise<void> {
  let pending = items;
  while (pending.length > 0) {
    try {
      const result = await stateSubjectEquivalences({ items: pending, reason: EQUIVALENCE_REASON, statedBy: STATED_BY });
      report.recorded += result.recordedCount;
      report.alreadyRecorded += result.alreadyRecordedCount;
      return;
    } catch (err) {
      if (!(err instanceof EquivalencesRefusedError) || err.refusals.length === 0) throw err;
      const refusedIdx = new Set<number>();
      for (const r of err.refusals) {
        const item = pending[r.index];
        if (!item) throw new Error(`runs-service refused an unknown item index ${r.index}`);
        refusedIdx.add(r.index);
        report.refused.push({ subscriberId: item.subjectId, leadId: item.targetId, reason: r.reason });
      }
      pending = pending.filter((_, i) => !refusedIdx.has(i));
    }
  }
}

export async function stateSubscriberLeads(opts: { dryRun: boolean }): Promise<SubscriberLeadsReport> {
  const subscribers = await sql<Array<{ id: string; email: string }>>`
    SELECT id::text AS id, email FROM mailing_list_subscribers ORDER BY email, id`;
  const answers = await resolveLeadsByEmail([...new Set(subscribers.map((s) => s.email.toLowerCase()))]);

  const report: SubscriberLeadsReport = {
    dryRun: opts.dryRun, subscribers: subscribers.length, resolved: 0, notALead: 0, ambiguous: 0, recorded: 0, alreadyRecorded: 0, refused: [],
  };
  const items: SubjectEquivalence[] = [];
  for (const s of subscribers) {
    const answer = answers.get(s.email.toLowerCase());
    if (answer?.leadId) {
      report.resolved += 1;
      items.push({ subjectService: SUBJECT_SERVICE, subjectId: s.id, targetService: LEAD_SUBJECT_SERVICE, targetId: answer.leadId });
    } else if (answer?.reason === "ambiguous") {
      report.ambiguous += 1;
    } else {
      report.notALead += 1;
    }
  }
  if (!opts.dryRun) {
    for (let offset = 0; offset < items.length; offset += EQUIVALENCE_CHUNK) {
      await stateChunk(items.slice(offset, offset + EQUIVALENCE_CHUNK), report);
    }
  }
  console.log(`[transactional-email-service] subscriber-lead equivalences: ${JSON.stringify({ ...report, refused: report.refused.length })}`);
  for (const r of report.refused) console.warn(`[transactional-email-service] equivalence refused: ${JSON.stringify(r)}`);
  return report;
}

// ─── Forward: a subscriber who is or becomes a lead ─────────────────────────
//
// In-process interval, first pass ~60s after the port is bound (deploys
// recreate the container more often than a long interval fires), then every
// SWEEP_INTERVAL_MS. A pass is ~32 + ~N/1000 small calls whatever happens; a
// pass still running when the next is due is skipped, never doubled.

export const SWEEP_FIRST_DELAY_MS = 60_000;
export const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
let running = false;

export async function runSubscriberLeadSweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await stateSubscriberLeads({ dryRun: false });
  } catch (err) {
    console.error("[transactional-email-service] subscriber-lead sweep failed (next pass retries):", err);
  } finally {
    running = false;
  }
}

export function startSubscriberLeadSweep(): void {
  if (timer || firstTimer) return;
  firstTimer = setTimeout(() => {
    firstTimer = null;
    void runSubscriberLeadSweep();
    timer = setInterval(() => void runSubscriberLeadSweep(), SWEEP_INTERVAL_MS);
  }, SWEEP_FIRST_DELAY_MS);
}

export function stopSubscriberLeadSweep(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
}
