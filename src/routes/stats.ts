import { Router } from "express";
import { requireApiKey, requireIdentityHeaders, type IdentityLocals } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { emailEvents } from "../db/schema.js";
import { eq, and, count } from "drizzle-orm";
import { StatsQuerySchema } from "../schemas.js";

const router = Router();

router.get("/stats", requireApiKey, requireIdentityHeaders, async (req, res) => {
  try {
    const parsed = StatsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { orgId } = res.locals as IdentityLocals;
    const conditions = [eq(emailEvents.orgId, orgId)];
    if (parsed.data.eventType) conditions.push(eq(emailEvents.eventType, parsed.data.eventType));

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
