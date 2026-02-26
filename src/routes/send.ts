import { Router } from "express";
import { eq } from "drizzle-orm";
import { requireApiKey } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { emailEvents } from "../db/schema.js";
import { getTemplate } from "../templates/index.js";
import { sendEmail } from "../lib/email-gateway.js";
import { resolveUserEmail } from "../lib/client-service.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { SendRequestSchema } from "../schemas.js";

const router = Router();

// Event types that are deduped (sent only once per key)
const ONCE_ONLY_EVENTS = new Set(["waitlist", "welcome", "signup_notification"]);

// Event types deduped per day (one per user per day)
const DAILY_DEDUP_EVENTS = new Set(["user_active"]);

// Event types deduped per user × product (one per recipient per product instance)
const PRODUCT_SCOPED_EVENTS = new Set(["webinar_welcome", "j_minus_3", "j_minus_2", "j_minus_1", "j_day"]);

// Events where recipient is hardcoded to admin
const ADMIN_EMAIL = "kevin@mcpfactory.org";
const ADMIN_NOTIFICATION_EVENTS = new Set(["signup_notification", "signin_notification", "user_active"]);

// System org ID for runs without a user org (admin notifications, etc.)
const SYSTEM_ORG_ID = "transactional-email-service";

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

function buildDedupKey(appId: string, eventType: string, req: { userId?: string; recipientEmail?: string; productId?: string }): string | null {
  // Product-scoped dedup: one per recipient per product instance
  if (PRODUCT_SCOPED_EVENTS.has(eventType)) {
    if (req.recipientEmail && req.productId) {
      return `${appId}:${eventType}:${req.recipientEmail}:${req.productId}`;
    }
    return null; // missing required fields, skip dedup
  }

  // Daily dedup: one per user per day
  if (DAILY_DEDUP_EVENTS.has(eventType)) {
    const identifier = req.userId || req.recipientEmail || "unknown";
    return `${appId}:${eventType}:${identifier}:${getTodayDate()}`;
  }

  // Once-only dedup
  if (ONCE_ONLY_EVENTS.has(eventType)) {
    if (eventType === "waitlist" && req.recipientEmail) {
      return `${appId}:waitlist:${req.recipientEmail}`;
    }
    if (req.userId) {
      return `${appId}:${eventType}:${req.userId}`;
    }
    // Anonymous fallback: dedup on email for once-only events
    if (req.recipientEmail) {
      return `${appId}:${eventType}:${req.recipientEmail}`;
    }
  }

  return null; // repeatable event, no dedup
}

router.post("/send", requireApiKey, async (req, res) => {
  try {
    const parsed = SendRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const body = parsed.data;

    // Resolve recipient emails
    let recipientEmails: string[];

    if (ADMIN_NOTIFICATION_EVENTS.has(body.eventType)) {
      recipientEmails = [ADMIN_EMAIL];
    } else if (body.userId) {
      const email = await resolveUserEmail(body.userId);
      recipientEmails = [email];
    } else if (body.recipientEmail) {
      recipientEmails = [body.recipientEmail];
    } else {
      res.status(400).json({ error: "One of userId or recipientEmail is required" });
      return;
    }

    // For admin notifications, enrich metadata with the user's email
    const metadata = { ...body.metadata };
    if (ADMIN_NOTIFICATION_EVENTS.has(body.eventType) && body.userId && !metadata.email) {
      try {
        const userEmail = await resolveUserEmail(body.userId);
        metadata.email = userEmail;
      } catch {
        // Continue without email in metadata
      }
    }

    // Get template
    const templateFn = await getTemplate(body.appId, body.eventType);
    const template = templateFn(metadata as Record<string, unknown>);

    const dedupKey = buildDedupKey(body.appId, body.eventType, body);
    const results: Array<{ email: string; sent: boolean; reason?: string }> = [];

    for (const email of recipientEmails) {
      // Build per-recipient dedup key (append email for org-wide sends)
      const recipientDedupKey = dedupKey && recipientEmails.length > 1
        ? `${dedupKey}:${email}`
        : dedupKey;

      // Create a run in runs-service before sending
      let run: { id: string } | null = null;

      try {
        run = await createRun({
          orgId: body.orgId || SYSTEM_ORG_ID,
          appId: body.appId,
          serviceName: "transactional-email-service",
          taskName: `email-${body.eventType}`,
          userId: body.userId,
          brandId: body.brandId,
          campaignId: body.campaignId,
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
              appId: body.appId,
              eventType: body.eventType,
              recipientEmail: email,
              dedupKey: recipientDedupKey,
              userId: body.userId || null,
              orgId: body.orgId || null,
              status: "pending",
              metadata: metadata || null,
            })
            .onConflictDoNothing({ target: emailEvents.dedupKey })
            .returning();

          if (inserted.length === 0) {
            await updateRun(run.id, "completed");
            results.push({ email, sent: false, reason: "duplicate" });
            continue;
          }

          insertedEventId = inserted[0].id;
        } else {
          // Repeatable event: insert for history
          const [inserted] = await db
            .insert(emailEvents)
            .values({
              appId: body.appId,
              eventType: body.eventType,
              recipientEmail: email,
              dedupKey: null,
              userId: body.userId || null,
              orgId: body.orgId || null,
              status: "pending",
              metadata: metadata || null,
            })
            .returning();

          insertedEventId = inserted.id;
        }

        // Send via email gateway
        await sendEmail({
          to: email,
          subject: template.subject,
          htmlBody: template.htmlBody,
          textBody: template.textBody,
          tag: `${body.appId}-${body.eventType}`,
          orgId: body.orgId,
          runId: run.id,
          appId: body.appId,
          brandId: body.brandId,
          campaignId: body.campaignId,
          from: template.from,
          messageStream: template.messageStream,
        });

        // Mark as sent only after successful delivery
        await db
          .update(emailEvents)
          .set({ status: "sent" })
          .where(eq(emailEvents.id, insertedEventId));

        await updateRun(run.id, "completed");
        results.push({ email, sent: true });
      } catch (err: any) {
        console.error(`Failed to send ${body.eventType} to ${email}:`, err.message);

        // Mark run as failed
        try {
          await updateRun(run.id, "failed");
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
