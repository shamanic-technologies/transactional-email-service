import { Router } from "express";
import { eq } from "drizzle-orm";
import { requireApiKey, requireIdentityHeaders, type IdentityLocals } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { emailEvents } from "../db/schema.js";
import { getTemplate } from "../templates/index.js";
import { sendEmail } from "../lib/email-gateway.js";
import { resolveUserEmail } from "../lib/client-service.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { traceEvent } from "../lib/trace-event.js";
import { SendRequestSchema } from "../schemas.js";

const router = Router();

// Event types that are deduped (sent only once per key)
const ONCE_ONLY_EVENTS = new Set(["waitlist", "welcome", "signup_notification"]);

// Event types deduped per day (one per user per day)
const DAILY_DEDUP_EVENTS = new Set(["user_active"]);

// Event types deduped per user × product (one per recipient per product instance)
const PRODUCT_SCOPED_EVENTS = new Set(["webinar_welcome", "j_minus_3", "j_minus_2", "j_minus_1", "j_day"]);

// Event types deduped per org × brand × calendar month (one nudge per brand per month)
const MONTHLY_BRAND_EVENTS = new Set(["audience_fully_contacted"]);

// Events where recipient is hardcoded to admin
const ADMIN_EMAILS = ["kevin@distribute.you"];
const ADMIN_NOTIFICATION_EVENTS = new Set(["signup_notification", "signin_notification", "user_active"]);


function getTodayDate(): string {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

function getCurrentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function buildDedupKey(orgId: string, eventType: string, req: { userId?: string; recipientEmail?: string; productId?: string; brandIds?: string[] }): string | null {
  // Monthly per-brand dedup: one send per org × brand × calendar month.
  // Brand + month derive entirely from the existing request (x-brand-id header / brandIds body).
  if (MONTHLY_BRAND_EVENTS.has(eventType)) {
    if (req.brandIds && req.brandIds.length > 0) {
      const brandKey = [...req.brandIds].sort().join(",");
      return `${orgId}:${eventType}:${brandKey}:${getCurrentMonth()}`;
    }
    return null; // no brand identity, skip dedup
  }

  // Product-scoped dedup: one per recipient per product instance
  if (PRODUCT_SCOPED_EVENTS.has(eventType)) {
    if (req.recipientEmail && req.productId) {
      return `${orgId}:${eventType}:${req.recipientEmail}:${req.productId}`;
    }
    return null; // missing required fields, skip dedup
  }

  // Daily dedup: one per user per day
  if (DAILY_DEDUP_EVENTS.has(eventType)) {
    const identifier = req.userId || req.recipientEmail || "unknown";
    return `${orgId}:${eventType}:${identifier}:${getTodayDate()}`;
  }

  // Once-only dedup
  if (ONCE_ONLY_EVENTS.has(eventType)) {
    if (eventType === "waitlist" && req.recipientEmail) {
      return `${orgId}:waitlist:${req.recipientEmail}`;
    }
    if (req.userId) {
      return `${orgId}:${eventType}:${req.userId}`;
    }
    // Anonymous fallback: dedup on email for once-only events
    if (req.recipientEmail) {
      return `${orgId}:${eventType}:${req.recipientEmail}`;
    }
  }

  return null; // repeatable event, no dedup
}

router.post("/send", requireApiKey, requireIdentityHeaders, async (req, res) => {
  try {
    const parsed = SendRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const body = parsed.data;
    const { orgId, userId, runId, campaignId: headerCampaignId, brandIds: headerBrandIds, workflowSlug, featureSlug, audienceId } = res.locals as IdentityLocals;

    // Headers take precedence over body for campaign/brand tracking
    const effectiveCampaignId = headerCampaignId || body.campaignId;
    const effectiveBrandIds = headerBrandIds ?? body.brandIds;

    // Identity headers for tracing
    const traceHeaders: Record<string, string | undefined> = {
      "x-org-id": orgId,
      "x-user-id": userId,
      "x-brand-id": headerBrandIds?.join(","),
      "x-campaign-id": headerCampaignId,
      "x-workflow-slug": workflowSlug,
      "x-feature-slug": featureSlug,
      "x-audience-id": audienceId,
    };

    // Resolve recipient emails
    let recipientEmails: string[];

    if (ADMIN_NOTIFICATION_EVENTS.has(body.eventType)) {
      recipientEmails = [...ADMIN_EMAILS];
    } else if (body.recipientEmail) {
      recipientEmails = [body.recipientEmail];
    } else {
      const email = await resolveUserEmail(userId, { orgId, userId, runId, campaignId: headerCampaignId, brandId: headerBrandIds?.join(","), workflowSlug, featureSlug, audienceId });
      recipientEmails = [email];
    }

    // For admin notifications, enrich metadata with the user's email
    const metadata = { ...body.metadata };
    if (ADMIN_NOTIFICATION_EVENTS.has(body.eventType) && userId && !metadata.email) {
      try {
        const userEmail = await resolveUserEmail(userId, { orgId, userId, runId, campaignId: headerCampaignId, brandId: headerBrandIds?.join(","), workflowSlug, featureSlug, audienceId });
        metadata.email = userEmail;
      } catch {
        // Continue without email in metadata
      }
    }

    // Get template
    let templateFn: Awaited<ReturnType<typeof getTemplate>>;
    try {
      templateFn = await getTemplate(body.eventType);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
      return;
    }
    const template = templateFn(metadata as Record<string, unknown>);

    if (runId) {
      traceEvent(runId, { service: "transactional-email-service", event: "template-resolved", detail: `Template resolved for ${body.eventType}` }, traceHeaders);
    }

    const dedupKey = buildDedupKey(orgId, body.eventType, { userId, ...body, brandIds: effectiveBrandIds });
    const results: Array<{ email: string; sent: boolean; reason?: string }> = [];

    for (const email of recipientEmails) {
      // Build per-recipient dedup key (append email for org-wide sends)
      const recipientDedupKey = dedupKey && recipientEmails.length > 1
        ? `${dedupKey}:${email}`
        : dedupKey;

      // Create a run in runs-service before sending
      let run: { id: string };

      try {
        run = await createRun({
          orgId,
          userId,
          serviceName: "transactional-email-service",
          taskName: `email-${body.eventType}`,
          brandIds: effectiveBrandIds,
          campaignId: effectiveCampaignId,
          parentRunId: runId,
          workflowHeaders: { campaignId: headerCampaignId, brandId: headerBrandIds?.join(","), workflowSlug, featureSlug, audienceId },
        });
      } catch (runErr: any) {
        console.error(`Failed to create run for ${body.eventType}:`, runErr.message);
        results.push({ email, sent: false, reason: `Run creation failed: ${runErr.message}` });
        continue;
      }

      let insertedEventId: string | null = null;

      try {
        // Insert with dedup — status "pending" until gateway confirms
        if (recipientDedupKey) {
          const inserted = await db
            .insert(emailEvents)
            .values({
              eventType: body.eventType,
              recipientEmail: email,
              dedupKey: recipientDedupKey,
              userId,
              orgId,
              status: "pending",
              metadata: metadata || null,
              campaignId: effectiveCampaignId || null,
              brandIds: effectiveBrandIds?.length ? effectiveBrandIds : null,
              workflowSlug: workflowSlug || null,
              featureSlug: featureSlug || null,
              audienceId: audienceId || null,
            })
            .onConflictDoNothing({ target: emailEvents.dedupKey })
            .returning();

          if (inserted.length === 0) {
            traceEvent(run.id, { service: "transactional-email-service", event: "send-dedup-skip", detail: `Duplicate ${body.eventType} for ${email}` }, traceHeaders);
            await updateRun(run.id, "completed", { orgId, userId }, { campaignId: headerCampaignId, brandId: headerBrandIds?.join(","), workflowSlug, featureSlug, audienceId });
            results.push({ email, sent: false, reason: "duplicate" });
            continue;
          }

          insertedEventId = inserted[0].id;
        } else {
          // Repeatable event: insert for history
          const [inserted] = await db
            .insert(emailEvents)
            .values({
              eventType: body.eventType,
              recipientEmail: email,
              dedupKey: null,
              userId,
              orgId,
              status: "pending",
              metadata: metadata || null,
              campaignId: effectiveCampaignId || null,
              brandIds: effectiveBrandIds?.length ? effectiveBrandIds : null,
              workflowSlug: workflowSlug || null,
              featureSlug: featureSlug || null,
              audienceId: audienceId || null,
            })
            .returning();

          insertedEventId = inserted.id;
        }

        // Send via email gateway
        traceEvent(run.id, { service: "transactional-email-service", event: "send-start", detail: `Sending ${body.eventType} to ${email}` }, traceHeaders);
        await sendEmail({
          to: email,
          subject: template.subject,
          htmlBody: template.htmlBody,
          textBody: template.textBody,
          tag: body.eventType,
          orgId,
          userId,
          runId: run.id,
          brandIds: effectiveBrandIds,
          campaignId: effectiveCampaignId,
          from: template.from,
          bcc: body.bccEmails?.join(","),
          workflowHeaders: { campaignId: headerCampaignId, brandId: headerBrandIds?.join(","), workflowSlug, featureSlug, audienceId },
        });

        // Mark as sent only after successful delivery
        await db
          .update(emailEvents)
          .set({ status: "sent" })
          .where(eq(emailEvents.id, insertedEventId));

        traceEvent(run.id, { service: "transactional-email-service", event: "send-done", detail: `Sent ${body.eventType} to ${email}` }, traceHeaders);
        await updateRun(run.id, "completed", { orgId, userId }, { campaignId: headerCampaignId, brandId: headerBrandIds?.join(","), workflowSlug, featureSlug, audienceId });
        results.push({ email, sent: true });
      } catch (err: any) {
        console.error(`Failed to send ${body.eventType} to ${email}:`, err.message);
        traceEvent(run.id, { service: "transactional-email-service", event: "send-error", detail: err.message, level: "error" }, traceHeaders);

        // Mark run as failed
        try {
          await updateRun(run.id, "failed", { orgId, userId }, { campaignId: headerCampaignId, brandId: headerBrandIds?.join(","), workflowSlug, featureSlug, audienceId });
        } catch {
          // Best effort
        }

        // Update event status to failed
        if (insertedEventId) {
          try {
            await db
              .update(emailEvents)
              .set({ status: "failed", errorMessage: err.message })
              .where(eq(emailEvents.id, insertedEventId));
          } catch {
            // Best effort
          }
        }

        results.push({ email, sent: false, reason: err.message });
      }
    }

    res.json({ results });
  } catch (error: any) {
    console.error("Send lifecycle email error:", error);
    res.status(500).json({ error: error.message || "Failed to send lifecycle email" });
  }
});

export default router;
