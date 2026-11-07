/**
 * A NEWSLETTER IS DRAFTED, THEN VALIDATED, THEN SENT: THREE OUTCOMES (NEWSLETTER-OUTCOMES-1107).
 *
 * Owner 2026-11-07: « There should be a difference between the outcomes of newsletter drafted, validated and
 * published right? ». Framework v10: the outcome is the WHAT, as fine as possible; who wrote it or approved it is a
 * tactic. So the chain reads, per issue:
 *
 *   newsletter_drafted   (subject = the draft row)  produced on the draft's own spend-free run
 *        ↓ consumed by
 *   newsletter_validated (subject = the same draft) produced on a spend-free run of the validator
 *        ↓ consumed by
 *   newsletter_email_sent (subject = one recipient row) per email, on the release's Units run (newsletter-units.ts)
 *
 * Names: `newsletter_drafted` follows the fleet's `<thing>_drafted` (x_post_drafted, linkedin_post_drafted);
 * `newsletter_validated` follows x_post_validated / linkedin_post_validated, the catalogue's existing word for
 * "the owner or the client approved the draft before publication". One word per meaning across channels.
 *
 * WHO PAYS: nothing. Drafting runs on a subscription (the daily-update job on Claude Max, no metered call) and a
 * validation is a human act, so neither run carries a cost row and none is invented. Their Units cost $0; what a
 * newsletter costs stays where it is spent (each email's send and verification).
 *
 * WHEN: the drafted Unit is declared inside `POST /mailing-lists/:slug/drafts` (the drafter's call fails loud on a
 * runs-service refusal and its retry returns the same draft, declaring what is still missing). The validated Unit is
 * declared inside the release create that names `draftId`, BEFORE the release is written: a release whose validation
 * cannot be recorded does not start, the same rule as its own run. A second release naming the same draft (a
 * re-create after a cancel, a relaunch) reuses the first validation: approving one issue twice is still one approval.
 *
 * Own module: the integration suites `vi.mock` runs-client.js and run-outcomes.js whole.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { newsletterDrafts, type NewsletterDraft } from "../db/schema.js";
import { createRun, updateRun } from "./runs-client.js";
import { declareRunOutcomes, type OutcomeOccurrence } from "./run-outcomes.js";
import { SUBJECT_SERVICE } from "./outcome-subject.js";

export const NEWSLETTER_DRAFTED = "newsletter_drafted";
export const NEWSLETTER_VALIDATED = "newsletter_validated";
export const DRAFTED_TASK = "newsletter-drafted";
export const VALIDATED_TASK = "newsletter-validated";

export function draftedSubject(draftId: string): OutcomeOccurrence {
  return { outcomeKey: NEWSLETTER_DRAFTED, subjectService: SUBJECT_SERVICE, subjectId: draftId };
}

export function validatedSubject(draftId: string): OutcomeOccurrence {
  return { outcomeKey: NEWSLETTER_VALIDATED, subjectService: SUBJECT_SERVICE, subjectId: draftId };
}

/** Same draft = same subject + both parts. The sender is the release's decision, not the draft's. */
export function draftFingerprint(input: { subject: string; htmlBody: string; textBody: string }): string {
  return createHash("sha256")
    .update([input.subject, input.htmlBody, input.textBody].join(String.fromCharCode(31)))
    .digest("hex");
}

export interface DraftIdentity {
  orgId: string;
  userId: string;
  runId?: string;
  brandIds?: string[];
}

/** Opens a spend-free run and closes it at once: it only states a Unit. */
async function openSpendFreeRun(identity: DraftIdentity, taskName: string, parentRunId: string | undefined): Promise<string> {
  const workflowHeaders = { brandId: identity.brandIds?.join(",") || undefined };
  const run = await createRun({
    orgId: identity.orgId,
    userId: identity.userId,
    serviceName: SUBJECT_SERVICE,
    taskName,
    parentRunId,
    ...(identity.brandIds?.length ? { brandIds: identity.brandIds } : {}),
    workflowHeaders,
  });
  await updateRun(run.id, "completed", { orgId: identity.orgId, userId: identity.userId }, workflowHeaders);
  return run.id;
}

/** Opens the drafted run. Called before the draft row is written: a draft that cannot be tracked is not registered. */
export function openDraftedRun(identity: DraftIdentity): Promise<string> {
  return openSpendFreeRun(identity, DRAFTED_TASK, identity.runId);
}

/** Declares the drafted Unit if it is not yet. Throws on a refusal (the row stays undeclared; the caller retries). */
export async function declareDrafted(draft: NewsletterDraft): Promise<NewsletterDraft> {
  if (draft.draftedDeclaredAt) return draft;
  await declareRunOutcomes(
    draft.draftedRunId,
    { orgId: draft.orgId, userId: draft.userId },
    { produced: [draftedSubject(draft.id)], occurredAt: draft.draftedAt.toISOString() }
  );
  const [updated] = await db
    .update(newsletterDrafts)
    .set({ draftedDeclaredAt: new Date() })
    .where(eq(newsletterDrafts.id, draft.id))
    .returning();
  return updated;
}

/**
 * The owner's go on a draft: declares `newsletter_validated` consuming `newsletter_drafted`, once per draft. The run is
 * the validator's (the release's acting user) on the draft's org. Throws on a refusal: the validated run id is kept, so
 * the retry declares on the same run.
 */
export async function validateDraft(draft: NewsletterDraft, validator: { userId: string; runId?: string }): Promise<NewsletterDraft> {
  let current = await declareDrafted(draft);
  if (current.validatedDeclaredAt) return current;

  if (!current.validatedRunId) {
    const validatedAt = new Date();
    const runId = await openSpendFreeRun(
      { orgId: current.orgId, userId: validator.userId, brandIds: current.brandIds ?? undefined },
      VALIDATED_TASK,
      // The validator's own run, never the drafted one: the drafted run states a fact dated at `draftedAt` (before
      // the run opened), and runs-service gives such a run no child run (409 run_holds_dated_facts, seen in prod
      // 2026-11-07). The chain lives in the ledger (validated consumes drafted), not in the run tree.
      validator.runId
    );
    const [stored] = await db
      .update(newsletterDrafts)
      .set({ validatedRunId: runId, validatedAt, validatedByUserId: validator.userId })
      .where(and(eq(newsletterDrafts.id, current.id), isNull(newsletterDrafts.validatedRunId)))
      .returning();
    if (stored) current = stored;
    else [current] = await db.select().from(newsletterDrafts).where(eq(newsletterDrafts.id, current.id));
  }

  await declareRunOutcomes(
    current.validatedRunId!,
    { orgId: current.orgId, userId: current.validatedByUserId! },
    {
      produced: [validatedSubject(current.id)],
      consumed: [draftedSubject(current.id)],
      occurredAt: current.validatedAt!.toISOString(),
    }
  );
  const [updated] = await db
    .update(newsletterDrafts)
    .set({ validatedDeclaredAt: new Date() })
    .where(eq(newsletterDrafts.id, current.id))
    .returning();
  return updated;
}

export function describeDraft(draft: NewsletterDraft, slug: string) {
  return {
    draftId: draft.id,
    slug,
    subject: draft.subject,
    bodyKind: draft.bodyKind,
    draftedAt: draft.draftedAt.toISOString(),
    draftedRunId: draft.draftedRunId,
    draftedDeclared: draft.draftedDeclaredAt !== null,
    validatedAt: draft.validatedAt?.toISOString() ?? null,
    validatedRunId: draft.validatedRunId ?? null,
    validatedDeclared: draft.validatedDeclaredAt !== null,
  };
}
