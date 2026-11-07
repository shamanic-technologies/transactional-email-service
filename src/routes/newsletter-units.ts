import { Router } from "express";
import { sql as raw } from "drizzle-orm";
import { requireApiKey } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { messageOf } from "../lib/db-error.js";
import { declareNewsletterUnits, NEWSLETTER_EMAIL_SENT, UNIT_LINK_PARAM } from "../lib/newsletter-units.js";
import { SUBJECT_SERVICE } from "../lib/outcome-subject.js";
import { NEWSLETTER_DRAFTED, NEWSLETTER_VALIDATED } from "../lib/newsletter-drafts.js";

/**
 * OUTCOME-FINEST-1106. The newsletter releases as factory output: each release with the ledger handles its Units
 * live under, so a reader (features-service) can sum, per release, the `newsletter_email_sent` Units, what they cost
 * and what consumed them (visits, then signups) from runs-service `GET /internal/outcome-occurrences`.
 */
const router = Router();

router.get("/internal/mailing-list-releases", requireApiKey, async (_req, res) => {
  try {
    const rows = (await db.execute(raw`
      SELECT r.id::text AS release_id, l.slug, r.subject, r.status, r.org_id, r.user_id, r.brand_ids, r.campaign_id,
             r.run_id::text AS run_id, r.units_run_id::text AS units_run_id, r.recipient_count,
             r.draft_id::text AS draft_id, d.drafted_run_id::text AS drafted_run_id, d.validated_run_id::text AS validated_run_id,
             r.created_at, r.completed_at,
             count(x.id) FILTER (WHERE x.status = 'sent')::int AS emails_sent,
             count(x.id) FILTER (WHERE x.status = 'sent' AND x.unit_declared_at IS NOT NULL)::int AS units_declared,
             min(x.settled_at) FILTER (WHERE x.status = 'sent') AS first_sent_at,
             max(x.settled_at) FILTER (WHERE x.status = 'sent') AS last_sent_at
        FROM mailing_list_releases r
        JOIN mailing_lists l ON l.id = r.list_id
        LEFT JOIN newsletter_drafts d ON d.id = r.draft_id
        LEFT JOIN mailing_list_release_recipients x ON x.release_id = r.id
       GROUP BY r.id, l.slug, d.id
       ORDER BY r.created_at DESC
    `)) as unknown as Array<Record<string, any>>;
    const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
    res.json({
      outcomeKey: NEWSLETTER_EMAIL_SENT,
      draftedOutcomeKey: NEWSLETTER_DRAFTED,
      validatedOutcomeKey: NEWSLETTER_VALIDATED,
      subjectService: SUBJECT_SERVICE,
      unitLinkParam: UNIT_LINK_PARAM,
      count: rows.length,
      releases: rows.map((r) => ({
        releaseId: r.release_id,
        listSlug: r.slug,
        subject: r.subject,
        status: r.status,
        orgId: r.org_id,
        userId: r.user_id,
        brandIds: r.brand_ids ?? [],
        campaignId: r.campaign_id,
        runId: r.run_id,
        unitsRunId: r.units_run_id,
        // NEWSLETTER-OUTCOMES-1107: the chain before the emails. Null on a release made from no draft.
        draftId: r.draft_id,
        draftedRunId: r.drafted_run_id,
        validatedRunId: r.validated_run_id,
        recipientCount: r.recipient_count,
        emailsSent: r.emails_sent,
        unitsDeclared: r.units_declared,
        firstSentAt: iso(r.first_sent_at),
        lastSentAt: iso(r.last_sent_at),
        createdAt: iso(r.created_at),
        completedAt: iso(r.completed_at),
      })),
    });
  } catch (error: any) {
    console.error("[transactional-email-service] list releases (units) error:", error);
    res.status(500).json({ error: messageOf(error) || "Failed to read releases" });
  }
});

/** One declaration pass now (the in-process worker runs the same pass every minute). */
router.post("/internal/newsletter-units/declare", requireApiKey, async (_req, res) => {
  try {
    res.json(await declareNewsletterUnits());
  } catch (error: any) {
    console.error("[transactional-email-service] newsletter Units pass error:", error);
    res.status(502).json({ error: messageOf(error) || "Newsletter Units pass failed" });
  }
});

export default router;
