import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql as raw } from "drizzle-orm";
import { requireApiKey, requireOrgIdOnly, type PlatformIdentityLocals } from "../middleware/auth.js";
import { db } from "../db/index.js";
import {
  mailingListReleaseRecipients,
  mailingListReleases,
  mailingLists,
  mailingListSubscribers,
  type MailingListRelease,
} from "../db/schema.js";
import { resolveBody } from "../lib/update-body.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { traceEvent } from "../lib/trace-event.js";
import { readProgress, runReleaseTick } from "../lib/release-worker.js";
import { estimateDaysRemaining, tickAllowance } from "../lib/release-pacing.js";
import { CreateReleaseRequestSchema, UpdateReleasePaceRequestSchema } from "../schemas.js";
import { DEFAULT_MAILING_LIST_FROM_ADDRESS } from "../lib/mailing-list-sender.js";

/**
 * Releasing one written update to a list over several days.
 *
 * The synchronous send next door does the whole list inside the request that
 * asked for it, which is right for a list of one and impossible for a list of
 * thirty thousand. These routes hand the work to a worker instead: creating a
 * release writes a ledger row per address and answers immediately, and nothing
 * here ever holds a connection open for a send.
 *
 * All of it is staff-only and platform-level, exactly like the rest of the
 * mailing-list surface. The organisation and acting user on the request are not
 * a scope — nothing is filtered by them — they are the identity the release
 * will send under days later, which is why they are copied onto the row.
 */

const router = Router();

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses a release can still be worked on from. */
const LIVE_STATUSES = ["running", "paused"];

/** Why a release that has ended, or stopped itself, does not take a new pace. */
function paceRefusal(status: string): string {
  if (status === "completed") return "This release has finished. There is nobody left to pace.";
  if (status === "cancelled") return "A cancelled release never resumes, so its pace cannot be changed. Create a new release to send this update again.";
  if (status === "halted")
    return "This release stopped itself on the provider's own delivery outcomes. Its pace is not changed: that decision stands until the reason has been dealt with and a new release is created.";
  return `A release that is ${status} cannot have its pace changed`;
}

function identityOf(res: Response): PlatformIdentityLocals {
  return res.locals as PlatformIdentityLocals;
}

function requireActingUser(res: Response): string | null {
  const { userId } = identityOf(res);
  if (!userId) {
    res.status(400).json({
      error: "Missing required header: x-user-id — mailing-list operations act as a staff user",
    });
    return null;
  }
  return userId;
}

function readSlug(req: Request, res: Response): string | null {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: `Invalid list slug '${slug}': lower-case letters, digits and hyphens only` });
    return null;
  }
  return slug;
}

function readReleaseId(req: Request, res: Response): string | null {
  const id = req.params.releaseId;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: `Invalid release id '${id}'` });
    return null;
  }
  return id;
}

/**
 * The fingerprint that makes issuing the same release twice a no-op.
 *
 * It covers everything a recipient would see a difference in. Two requests that
 * agree on all of it are the same update however many times a console retries,
 * and the second one is answered with the release the first one created rather
 * than a second release over the same thirty thousand people.
 */
function fingerprint(input: { subject: string; htmlBody: string; textBody: string; from: string }): string {
  const separator = String.fromCharCode(31);
  return createHash("sha256")
    .update([input.subject, input.htmlBody, input.textBody, input.from].join(separator))
    .digest("hex");
}

async function findList(slug: string) {
  const [list] = await db.select().from(mailingLists).where(eq(mailingLists.slug, slug)).limit(1);
  return list ?? null;
}

async function findRelease(releaseId: string) {
  const [row] = await db
    .select({ release: mailingListReleases, slug: mailingLists.slug })
    .from(mailingListReleases)
    .innerJoin(mailingLists, eq(mailingLists.id, mailingListReleases.listId))
    .where(eq(mailingListReleases.id, releaseId))
    .limit(1);
  return row ?? null;
}

async function describe(release: MailingListRelease, slug: string, now = new Date()) {
  const progress = await readProgress(release.id, now);

  return {
    releaseId: release.id,
    slug,
    subject: release.subject,
    from: release.fromAddress,
    bodyKind: release.bodyKind,
    status: release.status,
    haltedReason: release.haltedReason,
    dailyLimit: release.dailyLimit,
    recipientCount: release.recipientCount,
    reached: progress.reached,
    remaining: progress.remaining,
    failed: progress.failed,
    skippedOptedOut: progress.skippedOptedOut,
    inFlight: progress.inFlight,
    todayAllowance: release.dailyLimit,
    todayUsed: progress.todayUsed,
    // Stated from where the release stands rather than from its size, so it
    // answers the question staff ask right after changing the pace. A release
    // that will not run again has no days left whatever is still pending.
    estimatedDaysRemaining: LIVE_STATUSES.includes(release.status)
      ? estimateDaysRemaining({
          dailyLimit: release.dailyLimit,
          remaining: progress.remaining,
          todayUsed: progress.todayUsed,
        })
      : 0,
    nextSliceSize:
      release.status === "running"
        ? Math.min(
            progress.remaining,
            tickAllowance({ dailyLimit: release.dailyLimit, sentToday: progress.todayUsed, now })
          )
        : 0,
    createdAt: release.createdAt.toISOString(),
    completedAt: release.completedAt?.toISOString() ?? null,
  };
}

/**
 * POST /mailing-lists/:slug/releases
 *
 * Takes an update and a daily pace, writes down every address it covers, and
 * answers. Nothing is sent inside this request — that is the whole point, and
 * it is why the answer arrives in about a second whether the list holds one
 * address or thirty thousand: the recipient ledger is written by a single
 * set-based INSERT, so its cost does not walk the list in application code.
 *
 * Issuing the same update twice returns the release the first request created,
 * with `created: false`. The comparison is over everything a recipient could
 * see a difference in, so a console that retried a timed-out request cannot
 * start a second release over the same people. A release that was cancelled or
 * has completed does not block a new one with the same content: staff choosing
 * to send the same update again is a decision they are allowed to make, and it
 * writes a fresh ledger.
 */
router.post("/mailing-lists/:slug/releases", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const slug = readSlug(req, res);
  if (!slug) return;

  const parsed = CreateReleaseRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { subject, dailyLimit } = parsed.data;
  const fromAddress = parsed.data.from ?? DEFAULT_MAILING_LIST_FROM_ADDRESS;

  const resolved = resolveBody(parsed.data);
  if ("error" in resolved) {
    res.status(400).json({ error: resolved.error });
    return;
  }

  // Refused here for the same reason the synchronous send refuses it: an SVG
  // reaches every recipient as a broken placeholder, and a release would carry
  // that to thirty thousand people over several days before anybody looked.
  if (resolved.unrenderableImages.length > 0) {
    res.status(400).json({
      error:
        `Email clients do not render SVG images. Gmail, Outlook and Yahoo show the alt text instead. ` +
        `Use a PNG or JPEG for: ${resolved.unrenderableImages.join(", ")}`,
    });
    return;
  }

  const userId = requireActingUser(res);
  if (!userId) return;

  const identity = identityOf(res);

  try {
    const list = await findList(slug);
    if (!list) {
      res.status(404).json({ error: `No mailing list '${slug}'` });
      return;
    }

    const [counted] = await db
      .select({ count: raw<number>`count(*)::int` })
      .from(mailingListSubscribers)
      .where(eq(mailingListSubscribers.listId, list.id));
    const memberCount = Number(counted?.count ?? 0);

    if (memberCount === 0) {
      res.status(400).json({ error: `Mailing list '${slug}' has no subscribers` });
      return;
    }

    const dedupKey = fingerprint({
      subject,
      htmlBody: resolved.htmlBody,
      textBody: resolved.textBody,
      from: fromAddress,
    });

    const [existing] = await db
      .select()
      .from(mailingListReleases)
      .where(
        and(
          eq(mailingListReleases.listId, list.id),
          eq(mailingListReleases.dedupKey, dedupKey),
          inArray(mailingListReleases.status, LIVE_STATUSES)
        )
      )
      .limit(1);

    if (existing) {
      res.json({ created: false, estimatedDays: Math.ceil(existing.recipientCount / existing.dailyLimit), ...(await describe(existing, slug)) });
      return;
    }

    // The run is created before anything is written, because it is the key the
    // provider's outcomes for this release are read back by and the identity
    // every message days from now is tracked under. A release that cannot be
    // tracked does not start.
    const run = await createRun({
      orgId: identity.orgId,
      userId,
      serviceName: "transactional-email-service",
      taskName: `mailing-list-release-${slug}`,
      parentRunId: identity.runId,
      brandIds: identity.brandIds,
      campaignId: identity.campaignId,
      workflowHeaders: {
        campaignId: identity.campaignId,
        brandId: identity.brandIds?.join(","),
        workflowSlug: identity.workflowSlug,
        featureSlug: identity.featureSlug,
        audienceId: identity.audienceId,
      },
    });

    const [release] = await db
      .insert(mailingListReleases)
      .values({
        listId: list.id,
        subject,
        fromAddress,
        bodyKind: resolved.bodyKind,
        bodyMarkdown: resolved.markdown,
        htmlBody: resolved.htmlBody,
        textBody: resolved.textBody,
        dedupKey,
        dailyLimit,
        status: "running",
        recipientCount: memberCount,
        orgId: identity.orgId,
        userId,
        runId: run.id,
        campaignId: identity.campaignId ?? null,
        brandIds: identity.brandIds?.length ? identity.brandIds : null,
        workflowSlug: identity.workflowSlug ?? null,
        featureSlug: identity.featureSlug ?? null,
        audienceId: identity.audienceId ?? null,
      })
      .returning();

    // One statement, whatever the list's size. The id is stated rather than
    // left to the column default so this insert does not depend on whether that
    // default lives in the database or in the ORM.
    await db.execute(raw`
      INSERT INTO mailing_list_release_recipients (id, release_id, email, status)
      SELECT gen_random_uuid(), ${release.id}::uuid, email, 'pending'
      FROM mailing_list_subscribers
      WHERE list_id = ${list.id}::uuid
      ON CONFLICT DO NOTHING
    `);

    traceEvent(
      run.id,
      {
        service: "transactional-email-service",
        event: "mailing-list-release-created",
        detail: `'${subject}' will go to ${memberCount} subscriber(s) of '${slug}' from ${fromAddress}, at most ${dailyLimit} a day`,
      },
      {
        "x-org-id": identity.orgId,
        "x-user-id": userId,
        "x-campaign-id": identity.campaignId,
        "x-workflow-slug": identity.workflowSlug,
        "x-feature-slug": identity.featureSlug,
        "x-audience-id": identity.audienceId,
      }
    );

    res.status(201).json({
      created: true,
      estimatedDays: Math.ceil(memberCount / dailyLimit),
      ...(await describe(release, slug)),
    });
  } catch (error: any) {
    console.error("[transactional-email-service] Create release error:", error);
    res.status(502).json({ error: error.message || "Failed to create release" });
  }
});

/**
 * GET /mailing-lists/:slug/releases
 * Every release ever created for this list, newest first, each with its progress.
 */
router.get("/mailing-lists/:slug/releases", requireApiKey, requireOrgIdOnly, async (req, res) => {
  try {
    const slug = readSlug(req, res);
    if (!slug) return;

    const list = await findList(slug);
    if (!list) {
      res.status(404).json({ error: `No mailing list '${slug}'` });
      return;
    }

    const rows = await db
      .select()
      .from(mailingListReleases)
      .where(eq(mailingListReleases.listId, list.id))
      .orderBy(desc(mailingListReleases.createdAt));

    const now = new Date();
    res.json({
      slug,
      count: rows.length,
      releases: await Promise.all(rows.map((row) => describe(row, slug, now))),
    });
  } catch (error: any) {
    console.error("[transactional-email-service] List releases error:", error);
    res.status(500).json({ error: error.message || "Failed to read releases" });
  }
});

/**
 * GET /mailing-lists/releases/:releaseId
 * Where one release stands: reached, remaining, failed, today's allowance and
 * how much of it is spent. Counted from the ledger, so a redeploy does not
 * change the answer.
 */
router.get("/mailing-lists/releases/:releaseId", requireApiKey, requireOrgIdOnly, async (req, res) => {
  try {
    const releaseId = readReleaseId(req, res);
    if (!releaseId) return;

    const found = await findRelease(releaseId);
    if (!found) {
      res.status(404).json({ error: `No release '${releaseId}'` });
      return;
    }

    res.json(await describe(found.release, found.slug));
  } catch (error: any) {
    console.error("[transactional-email-service] Read release error:", error);
    res.status(500).json({ error: error.message || "Failed to read release" });
  }
});

/**
 * Move a release from one state to another, refusing the moves that are not
 * moves. A cancelled release never resumes, and a halted one is not resumed
 * either — it stopped because the provider's own outcomes said to, and putting
 * it back would be overriding that with nothing new to go on. Sending the same
 * update again is a new release, deliberately.
 */
async function transition(
  req: Request,
  res: Response,
  from: string[],
  to: string,
  refusal: (status: string) => string
): Promise<void> {
  try {
    const releaseId = readReleaseId(req, res);
    if (!releaseId) return;

    const found = await findRelease(releaseId);
    if (!found) {
      res.status(404).json({ error: `No release '${releaseId}'` });
      return;
    }

    if (!from.includes(found.release.status)) {
      res.status(409).json({ error: refusal(found.release.status) });
      return;
    }

    const now = new Date();
    const [updated] = await db
      .update(mailingListReleases)
      .set({
        status: to,
        updatedAt: now,
        ...(to === "cancelled" ? { completedAt: now } : {}),
      })
      .where(and(eq(mailingListReleases.id, releaseId), inArray(mailingListReleases.status, from)))
      .returning();

    if (!updated) {
      // Somebody else moved it between the read and the write.
      res.status(409).json({ error: refusal(found.release.status) });
      return;
    }

    if (to === "cancelled") {
      // Addresses that were never going to be mailed are settled rather than
      // left pending, so the ledger states what happened to every one of them
      // instead of implying they are still waiting.
      await db
        .update(mailingListReleaseRecipients)
        .set({
          status: "cancelled",
          reason: "The release was cancelled before this address was reached.",
          settledAt: now,
        })
        .where(
          and(
            eq(mailingListReleaseRecipients.releaseId, releaseId),
            eq(mailingListReleaseRecipients.status, "pending")
          )
        );

      await updateRun(
        updated.runId,
        "completed",
        { orgId: updated.orgId, userId: updated.userId },
        {
          campaignId: updated.campaignId ?? undefined,
          brandId: updated.brandIds?.join(","),
          workflowSlug: updated.workflowSlug ?? undefined,
          featureSlug: updated.featureSlug ?? undefined,
          audienceId: updated.audienceId ?? undefined,
        }
      );
    }

    traceEvent(
      updated.runId,
      {
        service: "transactional-email-service",
        event: `mailing-list-release-${to}`,
        detail: `'${updated.subject}' is now ${to}`,
      },
      { "x-org-id": updated.orgId, "x-user-id": updated.userId }
    );

    res.json(await describe(updated, found.slug, now));
  } catch (error: any) {
    console.error(`[transactional-email-service] Release ${to} error:`, error);
    res.status(500).json({ error: error.message || `Failed to ${to} release` });
  }
}

/** POST /mailing-lists/releases/:releaseId/pause — stops within one tick. */
router.post("/mailing-lists/releases/:releaseId/pause", requireApiKey, requireOrgIdOnly, (req, res) =>
  transition(req, res, ["running"], "paused", (status) => `A release that is ${status} cannot be paused`)
);

/** POST /mailing-lists/releases/:releaseId/resume — continues where it stopped. */
router.post("/mailing-lists/releases/:releaseId/resume", requireApiKey, requireOrgIdOnly, (req, res) =>
  transition(req, res, ["paused"], "running", (status) =>
    status === "cancelled"
      ? "A cancelled release never resumes. Create a new release to send this update again."
      : status === "halted"
        ? "This release stopped itself on the provider's own delivery outcomes and is not resumed. Create a new release once the reason has been dealt with."
        : `A release that is ${status} cannot be resumed`
  )
);

/**
 * PATCH /mailing-lists/releases/:releaseId/pace
 *
 * Change how fast a release goes out, while it is going out.
 *
 * The pace a release was created with is a guess made before a single message
 * had left, and the reason a release is paced at all — sending reputation — is
 * the one thing that guess could not be informed by. This takes the decision
 * again on the evidence the release has since produced.
 *
 * It writes one column and touches the ledger not at all, which is what makes
 * the two guarantees hold across any number of changes: nobody already reached
 * is reached again, and nobody still waiting is dropped. The worker re-reads
 * the pace on its next wake, so a raise is spendable within a tick rather than
 * at midnight, and a lowering below what today already sent needs no special
 * case — `tickAllowance` returns 0 for a day whose allowance is already spent,
 * which is exactly a day that rests.
 *
 * Only a running or paused release takes a new pace. A completed one has
 * nothing left to pace, a cancelled one never resumes, and a halted one stopped
 * on the provider's own outcomes — re-pacing that would be overriding a
 * decision with nothing new to go on, which is the same reasoning that refuses
 * to resume it.
 */
router.patch("/mailing-lists/releases/:releaseId/pace", requireApiKey, requireOrgIdOnly, async (req, res) => {
  try {
    const releaseId = readReleaseId(req, res);
    if (!releaseId) return;

    const parsed = UpdateReleasePaceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const { dailyLimit } = parsed.data;

    const found = await findRelease(releaseId);
    if (!found) {
      res.status(404).json({ error: `No release '${releaseId}'` });
      return;
    }

    if (!LIVE_STATUSES.includes(found.release.status)) {
      res.status(409).json({ error: paceRefusal(found.release.status) });
      return;
    }

    const previous = found.release.dailyLimit;
    const now = new Date();
    const [updated] = await db
      .update(mailingListReleases)
      .set({ dailyLimit, updatedAt: now })
      .where(and(eq(mailingListReleases.id, releaseId), inArray(mailingListReleases.status, LIVE_STATUSES)))
      .returning();

    if (!updated) {
      // Somebody ended it between the read and the write. Its decision stands.
      const current = await findRelease(releaseId);
      res.status(409).json({ error: paceRefusal(current?.release.status ?? found.release.status) });
      return;
    }

    traceEvent(
      updated.runId,
      {
        service: "transactional-email-service",
        event: "mailing-list-release-repaced",
        detail: `'${updated.subject}' goes from ${previous} to ${dailyLimit} a day`,
      },
      { "x-org-id": updated.orgId, "x-user-id": updated.userId }
    );

    res.json(await describe(updated, found.slug, now));
  } catch (error: any) {
    console.error("[transactional-email-service] Release pace error:", error);
    res.status(500).json({ error: error.message || "Failed to change release pace" });
  }
});

/** POST /mailing-lists/releases/:releaseId/cancel — ends it; it never resumes. */
router.post("/mailing-lists/releases/:releaseId/cancel", requireApiKey, requireOrgIdOnly, (req, res) =>
  transition(req, res, ["running", "paused", "halted"], "cancelled", (status) =>
    `A release that is ${status} cannot be cancelled`
  )
);

/**
 * POST /internal/mailing-lists/releases/tick
 *
 * Runs one pass of the worker and says what it did. The worker runs on its own
 * interval inside this process; this exists so a cron can be a backstop for a
 * process that died, and so a caller can drive the pace without waiting on a
 * clock. It is safe to call at any time: the same guard that keeps two
 * intervals from overlapping answers `skippedBusy` here.
 */
router.post("/internal/mailing-lists/releases/tick", requireApiKey, async (_req, res) => {
  try {
    res.json(await runReleaseTick());
  } catch (error: any) {
    console.error("[transactional-email-service] Release tick error:", error);
    res.status(500).json({ error: error.message || "Release tick failed" });
  }
});

export default router;
