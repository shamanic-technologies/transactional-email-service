import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { emailEvents } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { TransferBrandRequestSchema } from "../schemas.js";

const router = Router();

router.post("/internal/transfer-brand", requireApiKey, async (req, res) => {
  try {
    const parsed = TransferBrandRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

    // Step 1: Move solo-brand rows from sourceOrg to targetOrg
    const moved = await db
      .update(emailEvents)
      .set({ orgId: targetOrgId })
      .where(
        and(
          eq(emailEvents.orgId, sourceOrgId),
          sql`array_length(${emailEvents.brandIds}, 1) = 1`,
          sql`${emailEvents.brandIds}[1] = ${sourceBrandId}`
        )
      )
      .returning({ id: emailEvents.id });

    // Step 2: If targetBrandId provided, rewrite brand reference globally (no org filter)
    let rewritten: { id: string }[] = [];
    if (targetBrandId) {
      rewritten = await db
        .update(emailEvents)
        .set({ brandIds: [targetBrandId] })
        .where(
          and(
            sql`array_length(${emailEvents.brandIds}, 1) = 1`,
            sql`${emailEvents.brandIds}[1] = ${sourceBrandId}`
          )
        )
        .returning({ id: emailEvents.id });
    }

    const totalUpdated = Math.max(moved.length, rewritten.length);
    console.log(`[transactional-email-service] transfer-brand: moved ${moved.length} email_events rows (${sourceOrgId} -> ${targetOrgId})${targetBrandId ? `, rewrote ${rewritten.length} rows (${sourceBrandId} -> ${targetBrandId})` : ""}`);

    res.json({
      updatedTables: [{ tableName: "email_events", count: totalUpdated }],
    });
  } catch (error: any) {
    console.error("[transactional-email-service] transfer-brand error:", error);
    res.status(500).json({ error: error.message || "Failed to transfer brand" });
  }
});

export default router;
