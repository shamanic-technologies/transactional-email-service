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

    // Solo-brand only: brand_ids array has exactly one element and it matches sourceBrandId
    // When targetBrandId is present, also rewrite the brand reference
    const setClause = targetBrandId
      ? { orgId: targetOrgId, brandIds: [targetBrandId] }
      : { orgId: targetOrgId };

    const updated = await db
      .update(emailEvents)
      .set(setClause)
      .where(
        and(
          eq(emailEvents.orgId, sourceOrgId),
          sql`array_length(${emailEvents.brandIds}, 1) = 1`,
          sql`${emailEvents.brandIds}[1] = ${sourceBrandId}`
        )
      )
      .returning({ id: emailEvents.id });

    console.log(`[transactional-email-service] transfer-brand: updated ${updated.length} email_events rows (sourceBrandId=${sourceBrandId}${targetBrandId ? `, targetBrandId=${targetBrandId}` : ""}, ${sourceOrgId} -> ${targetOrgId})`);

    res.json({
      updatedTables: [{ tableName: "email_events", count: updated.length }],
    });
  } catch (error: any) {
    console.error("[transactional-email-service] transfer-brand error:", error);
    res.status(500).json({ error: error.message || "Failed to transfer brand" });
  }
});

export default router;
