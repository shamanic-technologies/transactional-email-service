/**
 * Who a mailing-list release send reaches, as the cost ledger names them
 * (COST-ACCOUNTING-1023, agent-config skill `cost-accounting`).
 *
 * postmark-service declares `message_sent` on a send's run for the person the
 * sender names, and declares the send's inputs (`consumedOutcomeKeys`) on that
 * same person. A subscriber is not a lead in lead-service: this service is the
 * one that knows them, so the subject is ours — the subscriber row's id. It is
 * one row per (list, address), so it is the same id on every release of that
 * list and on every step (the verification before the send included).
 *
 * Only a release send names a subject. A transactional send (receipt, code,
 * staff alert, lifecycle notification) is a support function: it names nobody
 * and declares nothing.
 *
 * Own module because the worker's integration tests `vi.mock` whole modules
 * (email-gateway, email-verification, release-health): a helper exported from
 * one of those would come back undefined inside the send path.
 */

export const SUBJECT_SERVICE = "transactional-email-service";

/** Every release recipient is verified before it is sent (only verdict `valid` goes out). */
export const RELEASE_SEND_CONSUMES = ["email_checked"] as const;

export interface OutcomeSubject {
  subjectService: string;
  subjectId: string;
}

export function subscriberSubject(subscriberId: string): OutcomeSubject {
  return { subjectService: SUBJECT_SERVICE, subjectId: subscriberId };
}
