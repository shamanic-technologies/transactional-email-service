import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { requireApiKey, requireOrgIdOnly, type PlatformIdentityLocals } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { mailingLists, mailingListSubscribers, mailingListUpdates } from "../db/schema.js";
import { parseAddressBlob } from "../lib/address-blob.js";
import { findUnrenderableImages, renderUpdateBody } from "../lib/mailing-list-body.js";
import { fetchSuppressed } from "../lib/suppression.js";
import { sendEmail } from "../lib/email-gateway.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  AddSubscribersRequestSchema,
  PreviewUpdateRequestSchema,
  SendUpdateRequestSchema,
} from "../schemas.js";

const router = Router();

/**
 * Mailing lists are staff-owned and platform-level: a list such as `investors`
 * belongs to no customer organisation and its members are bare email addresses
 * with no source resource. The routes take an organisation header only because
 * the downstream send needs a sending identity (Postmark key resolution), never
 * to scope the data — nothing here is filtered by org.
 *
 * Every update is sent one message per recipient, so no recipient ever appears
 * in another recipient's headers.
 */

/** Every update is sent from this address. */
const MAILING_LIST_FROM_ADDRESS = "kevin@distribute.you";

/** Postmark accepts 500 messages per batch; per-recipient sends run in bounded waves. */
const SEND_CONCURRENCY = 8;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

interface Failure {
  email: string;
  reason: string;
}

function identityOf(res: Response): PlatformIdentityLocals {
  return res.locals as PlatformIdentityLocals;
}

/**
 * key-service resolves the Postmark token and stream against an acting user, so
 * every route that reads provider suppression state — and every send, which
 * billing-service bills to the acting user — needs one. Fail here with the real
 * reason rather than surfacing a 400 from two services away.
 */
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

function workflowHeadersOf(identity: PlatformIdentityLocals) {
  return {
    campaignId: identity.campaignId,
    brandId: identity.brandIds?.join(","),
    workflowSlug: identity.workflowSlug,
    featureSlug: identity.featureSlug,
    audienceId: identity.audienceId,
  };
}

function readSlug(req: Request, res: Response): string | null {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: `Invalid list slug '${slug}': lower-case letters, digits and hyphens only` });
    return null;
  }
  return slug;
}

async function findList(slug: string) {
  const [list] = await db.select().from(mailingLists).where(eq(mailingLists.slug, slug)).limit(1);
  return list ?? null;
}

/**
 * GET /mailing-lists/:slug/subscribers
 * Opt-out state is read live from the provider, never from local storage.
 */
router.get("/mailing-lists/:slug/subscribers", requireApiKey, requireOrgIdOnly, async (req, res) => {
  try {
    const slug = readSlug(req, res);
    if (!slug) return;

    const userId = requireActingUser(res);
    if (!userId) return;

    const list = await findList(slug);
    if (!list) {
      res.status(404).json({ error: `No mailing list '${slug}'` });
      return;
    }

    const rows = await db
      .select()
      .from(mailingListSubscribers)
      .where(eq(mailingListSubscribers.listId, list.id))
      .orderBy(mailingListSubscribers.createdAt);

    // Only these members' addresses are read, and a refresh inside the cache
    // window reuses the answer rather than asking Postmark again.
    const suppression = await fetchSuppressed(
      { orgId: identityOf(res).orgId, userId },
      "/mailing-lists/:slug/subscribers",
      rows.map((r) => r.email)
    );

    res.json({
      slug,
      count: rows.length,
      subscribers: rows.map((r) => ({
        email: r.email,
        optedOut: suppression.isSuppressed(r.email),
        optedOutReason: suppression.reasonFor(r.email),
        addedAt: r.createdAt.toISOString(),
      })),
    });
  } catch (error: any) {
    console.error("List subscribers error:", error);
    res.status(502).json({ error: error.message || "Failed to read subscribers" });
  }
});

/**
 * POST /mailing-lists/:slug/subscribers
 * Adds every readable address from a pasted blob. Creates the list on first use.
 * Re-pasting the same blob adds nothing.
 */
router.post("/mailing-lists/:slug/subscribers", requireApiKey, requireOrgIdOnly, async (req, res) => {
  try {
    const slug = readSlug(req, res);
    if (!slug) return;

    const parsed = AddSubscribersRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const blob = parseAddressBlob(parsed.data.raw);

    const [list] = await db
      .insert(mailingLists)
      .values({ slug })
      .onConflictDoUpdate({ target: mailingLists.slug, set: { slug } })
      .returning();

    const added: string[] = [];
    const skipped: string[] = [...blob.duplicates];

    for (const email of blob.emails) {
      const inserted = await db
        .insert(mailingListSubscribers)
        .values({ listId: list.id, email })
        .onConflictDoNothing({
          target: [mailingListSubscribers.listId, mailingListSubscribers.email],
        })
        .returning();

      if (inserted.length > 0) added.push(email);
      else skipped.push(email);
    }

    res.json({ slug, added, skipped, rejected: blob.rejected });
  } catch (error: any) {
    console.error("Add subscribers error:", error);
    res.status(500).json({ error: error.message || "Failed to add subscribers" });
  }
});

/**
 * DELETE /mailing-lists/:slug/subscribers?email=…
 */
router.delete("/mailing-lists/:slug/subscribers", requireApiKey, requireOrgIdOnly, async (req, res) => {
  try {
    const slug = readSlug(req, res);
    if (!slug) return;

    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    if (!email) {
      res.status(400).json({ error: "Missing required query parameter: email" });
      return;
    }

    const list = await findList(slug);
    if (!list) {
      res.status(404).json({ error: `No mailing list '${slug}'` });
      return;
    }

    const deleted = await db
      .delete(mailingListSubscribers)
      .where(and(eq(mailingListSubscribers.listId, list.id), eq(mailingListSubscribers.email, email)))
      .returning();

    if (deleted.length === 0) {
      res.status(404).json({ error: `'${email}' is not on list '${slug}'` });
      return;
    }

    res.json({ slug, email, removed: true });
  } catch (error: any) {
    console.error("Remove subscriber error:", error);
    res.status(500).json({ error: error.message || "Failed to remove subscriber" });
  }
});

/**
 * POST /mailing-lists/updates/preview
 *
 * Renders a draft the way a recipient will receive it, and does nothing else:
 * no message goes out, no update row is written, no suppression list is read.
 *
 * It exists because the author of an update could not see it until it had
 * already reached everyone. The admin console used to render its own preview,
 * which is the failure this replaces — that second rendering drifted the moment
 * this service grew its inline-styled renderer, so the console showed bare
 * markup while investors received a laid-out email, and nobody noticed until
 * someone looked at the screen. A copy of the renderer anywhere else drifts the
 * same way, so the preview is served from the same call `renderUpdateBody` a
 * real send makes and from nowhere else.
 *
 * No list slug: the body renders identically whoever receives it, and asking
 * for a list would imply otherwise. No acting user either — nothing here
 * resolves a provider key, sends, or spends, so requiring one would be a guard
 * against nothing.
 *
 * Images no client can render are REPORTED rather than refused. A send is
 * refused because the alternative is a broken placeholder in every inbox; a
 * preview's whole job is to show the author what they have, and the browser
 * renders SVG happily, which is exactly the trap. So the body still renders and
 * the offending URLs come back beside it.
 */
router.post("/mailing-lists/updates/preview", requireApiKey, requireOrgIdOnly, (req, res) => {
  const parsed = PreviewUpdateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { htmlBody, textBody } = renderUpdateBody(parsed.data.body);
  res.json({ htmlBody, textBody, unrenderableImages: findUnrenderableImages(parsed.data.body) });
});

/**
 * POST /mailing-lists/:slug/updates
 * Sends the update to every member the provider is not suppressing — one
 * message per recipient — and records what was sent.
 */
router.post("/mailing-lists/:slug/updates", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const slug = readSlug(req, res);
  if (!slug) return;

  const parsed = SendUpdateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { subject, body } = parsed.data;

  // The sender is the last place this is cheap to catch: it knows the body
  // before it goes out, and an SVG reaches the recipient as a broken-image
  // placeholder showing its alt text. Reject rather than send something
  // knowably broken.
  const unrenderable = findUnrenderableImages(body);
  if (unrenderable.length > 0) {
    res.status(400).json({
      error:
        `Email clients do not render SVG images. Gmail, Outlook and Yahoo show the alt text instead. ` +
        `Use a PNG or JPEG for: ${unrenderable.join(", ")}`,
    });
    return;
  }

  const userId = requireActingUser(res);
  if (!userId) return;

  const identity = identityOf(res);
  const workflowHeaders = workflowHeadersOf(identity);

  try {
    const list = await findList(slug);
    if (!list) {
      res.status(404).json({ error: `No mailing list '${slug}'` });
      return;
    }

    const members = await db
      .select()
      .from(mailingListSubscribers)
      .where(eq(mailingListSubscribers.listId, list.id))
      .orderBy(mailingListSubscribers.createdAt);

    if (members.length === 0) {
      res.status(400).json({ error: `Mailing list '${slug}' has no subscribers` });
      return;
    }

    const { htmlBody, textBody } = renderUpdateBody(body);

    // maxAgeMs: 0 — a send never reads a cached answer. Someone who opted out
    // a second ago, after a page load cached them as subscribed, is still
    // skipped here.
    const suppression = await fetchSuppressed(
      { orgId: identity.orgId, userId },
      "/mailing-lists/:slug/updates",
      members.map((m) => m.email),
      { maxAgeMs: 0 }
    );
    const skippedOptedOut = members.filter((m) => suppression.isSuppressed(m.email)).map((m) => m.email);
    const recipients = members.filter((m) => !suppression.isSuppressed(m.email)).map((m) => m.email);

    if (recipients.length === 0) {
      res.status(400).json({ error: `Every subscriber on '${slug}' is opted out` });
      return;
    }

    const run = await createRun({
      orgId: identity.orgId,
      userId: identity.userId,
      serviceName: "transactional-email-service",
      taskName: `mailing-list-update-${slug}`,
      parentRunId: identity.runId,
      workflowHeaders,
    });

    const traceHeaders: Record<string, string | undefined> = {
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-campaign-id": identity.campaignId,
      "x-workflow-slug": identity.workflowSlug,
      "x-feature-slug": identity.featureSlug,
      "x-audience-id": identity.audienceId,
    };

    traceEvent(
      run.id,
      {
        service: "transactional-email-service",
        event: "mailing-list-update-start",
        detail: `Sending '${subject}' to ${recipients.length} subscriber(s) of '${slug}'`,
      },
      traceHeaders
    );

    const failures: Failure[] = [];
    let sentCount = 0;

    // One message per recipient — never one message with everyone in BCC — sent
    // in bounded waves so a few thousand members neither stampede the gateway
    // nor serialise into a request timeout.
    for (let offset = 0; offset < recipients.length; offset += SEND_CONCURRENCY) {
      const wave = recipients.slice(offset, offset + SEND_CONCURRENCY);
      const outcomes = await Promise.all(
        wave.map(async (email) => {
          try {
            await sendEmail({
              to: email,
              subject,
              htmlBody,
              textBody,
              tag: `mailing-list-${slug}`,
              orgId: identity.orgId,
              userId: identity.userId,
              runId: run.id,
              from: MAILING_LIST_FROM_ADDRESS,
              workflowHeaders,
            });
            return { email, reason: null as string | null };
          } catch (err: any) {
            return { email, reason: err.message || "Unknown send error" };
          }
        })
      );

      for (const outcome of outcomes) {
        if (outcome.reason === null) sentCount++;
        else failures.push({ email: outcome.email, reason: outcome.reason });
      }
    }

    const status = failures.length === 0 ? "sent" : "partial";

    const [record] = await db
      .insert(mailingListUpdates)
      .values({
        listId: list.id,
        subject,
        bodyMarkdown: body,
        htmlBody,
        status,
        recipientCount: sentCount,
        failures,
      })
      .returning();

    traceEvent(
      run.id,
      {
        service: "transactional-email-service",
        event: "mailing-list-update-done",
        detail: `'${subject}' reached ${sentCount}/${recipients.length}; ${failures.length} failed`,
        ...(failures.length > 0 ? { level: "error" as const } : {}),
      },
      traceHeaders
    );

    await updateRun(
      run.id,
      failures.length === 0 ? "completed" : "failed",
      { orgId: identity.orgId, userId: identity.userId },
      workflowHeaders
    );

    res.json({
      updateId: record.id,
      slug,
      subject,
      status,
      recipientCount: sentCount,
      skippedOptedOut,
      failures,
    });
  } catch (error: any) {
    console.error("Send mailing-list update error:", error);
    res.status(500).json({ error: error.message || "Failed to send mailing-list update" });
  }
});

/**
 * GET /mailing-lists/:slug/updates
 * Every update ever sent to this list, newest first.
 */
router.get("/mailing-lists/:slug/updates", requireApiKey, requireOrgIdOnly, async (req, res) => {
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
      .from(mailingListUpdates)
      .where(eq(mailingListUpdates.listId, list.id))
      .orderBy(desc(mailingListUpdates.sentAt));

    res.json({
      slug,
      count: rows.length,
      updates: rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        body: r.bodyMarkdown,
        htmlBody: r.htmlBody,
        status: r.status,
        recipientCount: r.recipientCount,
        failures: r.failures,
        sentAt: r.sentAt.toISOString(),
      })),
    });
  } catch (error: any) {
    console.error("List updates error:", error);
    res.status(500).json({ error: error.message || "Failed to read updates" });
  }
});

export default router;
