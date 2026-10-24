/**
 * LEDGER-HISTORY-1024: every `email_checked` a release send consumes on a
 * subscriber has its producer in the runs-service ledger.
 *
 * Since 2026-10-23 14:35 a release names each address's subscriber when it asks
 * apollo-service to check it (`subjects` in email-verification.ts), and apollo
 * declares the check's `email_checked` on that subscriber. The ~52k checks
 * asked before named nobody, so a live send that REUSED one of those verdicts
 * consumes `email_checked` with no producer. Only this service knows which
 * subscriber an address is, so it names them here, once, through apollo's
 * door: apollo then declares `email_checked` on each past check, dated at the
 * check, on the run that paid.
 *
 * One subject per address (apollo matches every check of an address the
 * release asked for, whatever the list). An address on two lists (40 in prod,
 * investors + newsletter) is named after the subscriber of the list whose
 * release verified it FIRST, read from our own recipient rows (the first check
 * was asked for that list; a reused verdict belongs to it). An address no
 * release ever verified has no check to name: apollo counts it in
 * `subjectsWithoutCheck`.
 *
 * Idempotent on apollo's side (a check already parked, live or here, is
 * skipped), so a re-run parks nothing new. Fails loud: a refused call throws.
 *
 * Own module because the worker's integration tests `vi.mock` whole modules.
 */
import { sql } from "../db/index.js";
import { SUBJECT_SERVICE } from "./outcome-subject.js";

/** The source label every release verification is asked under (email-verification.ts). */
export const RELEASE_VERIFY_LABEL = "transactional-email-service:mailing-list-release";

/** apollo-service's per-call ceiling on POST /internal/outcome-declarations/named-subjects. */
export const NAMED_SUBJECTS_CHUNK = 500;

export interface AddressSubject {
  email: string;
  subscriberId: string;
}

/**
 * Every subscriber address, one subscriber per address: the list whose release
 * verified it first, else the oldest subscriber row. Deterministic.
 */
export async function readAddressSubjects(): Promise<AddressSubject[]> {
  const rows = await sql<Array<{ email: string; subscriber_id: string }>>`
    SELECT DISTINCT ON (s.email) s.email, s.id::text AS subscriber_id
      FROM mailing_list_subscribers s
      LEFT JOIN LATERAL (
        SELECT min(coalesce(x.claimed_at, x.settled_at)) AS first_checked_at
          FROM mailing_list_release_recipients x
          JOIN mailing_list_releases r ON r.id = x.release_id
         WHERE r.list_id = s.list_id
           AND x.email = s.email
           AND x.verification_id IS NOT NULL
      ) f ON true
     ORDER BY s.email, f.first_checked_at ASC NULLS LAST, s.created_at ASC, s.id ASC`;
  return rows.map((r) => ({ email: r.email, subscriberId: r.subscriber_id }));
}

export interface NamedSubjectsReport {
  dryRun: boolean;
  calls: number;
  subjects: number;
  checks: number;
  subjectsWithoutCheck: number;
  parked: number;
}

function apolloConfig(): { url: string; apiKey: string } {
  const url = process.env.APOLLO_SERVICE_URL;
  const apiKey = process.env.APOLLO_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("APOLLO_SERVICE_URL and APOLLO_SERVICE_API_KEY must be set");
  return { url, apiKey };
}

async function postNamedSubjects(dryRun: boolean, chunk: AddressSubject[]) {
  const { url, apiKey } = apolloConfig();
  const response = await fetch(`${url}/internal/outcome-declarations/named-subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      dryRun,
      callerLabel: RELEASE_VERIFY_LABEL,
      subjects: chunk.map((s) => ({ email: s.email, subjectService: SUBJECT_SERVICE, subjectId: s.subscriberId })),
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`apollo-service POST /internal/outcome-declarations/named-subjects ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as { subjects: number; checks: number; subjectsWithoutCheck: number; parked: number };
}

export async function nameSubscribersAtApollo(opts: { dryRun: boolean }): Promise<NamedSubjectsReport> {
  const subjects = await readAddressSubjects();
  const report: NamedSubjectsReport = { dryRun: opts.dryRun, calls: 0, subjects: 0, checks: 0, subjectsWithoutCheck: 0, parked: 0 };
  for (let offset = 0; offset < subjects.length; offset += NAMED_SUBJECTS_CHUNK) {
    const answer = await postNamedSubjects(opts.dryRun, subjects.slice(offset, offset + NAMED_SUBJECTS_CHUNK));
    report.calls += 1;
    report.subjects += answer.subjects;
    report.checks += answer.checks;
    report.subjectsWithoutCheck += answer.subjectsWithoutCheck;
    report.parked += answer.parked;
  }
  console.log(`[transactional-email-service] ledger subjects at apollo: ${JSON.stringify(report)}`);
  return report;
}
