import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { emailEvents } from "../db/schema.js";
import { sql, eq, and, inArray, count } from "drizzle-orm";
import { StatsRequestSchema } from "../schemas.js";

const router = Router();

router.post("/stats", requireApiKey, async (req, res) => {
  try {
    const parsed = StatsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const body = parsed.data;

    // Build filter conditions
    const conditions = [];
    if (body.appId) conditions.push(eq(emailEvents.appId, body.appId));
    if (body.orgId) conditions.push(eq(emailEvents.orgId, body.orgId));
    if (body.userId) conditions.push(eq(emailEvents.userId, body.userId));
    if (body.eventType) conditions.push(eq(emailEvents.eventType, body.eventType));

    if (conditions.length === 0) {
      res.status(400).json({ error: "At least one filter is required (appId, orgId, userId, or eventType)" });
      return;
    }

    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const rows = await db
      .select({
        status: emailEvents.status,
        count: count(),
      })
      .from(emailEvents)
      .where(where)
      .groupBy(emailEvents.status);

    const stats = {
      totalEmails: 0,
      sent: 0,
      failed: 0,
      pending: 0,
    };

    for (const row of rows) {
      const c = Number(row.count);
      stats.totalEmails += c;
      if (row.status === "sent") stats.sent += c;
      if (row.status === "failed") stats.failed += c;
      if (row.status === "pending") stats.pending += c;
    }

    res.json({ stats });
  } catch (error: any) {
    console.error("Stats error:", error);
    res.status(500).json({ error: error.message || "Failed to get stats" });
  }
});

export default router;
