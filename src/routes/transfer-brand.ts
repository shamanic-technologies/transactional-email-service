import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { TransferBrandRequestSchema } from "../schemas.js";
import { transferBrand } from "../lib/brand-transfer.js";
import { listSoloBrandCampaignIds } from "../lib/campaign-service.js";

const router = Router();

router.post("/internal/transfer-brand", requireApiKey, async (req, res) => {
  try {
    const parsed = TransferBrandRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

    // The brand's campaigns, wherever campaign-service holds them right now: the
    // orchestrator calls every service independently, so campaign-service may
    // already have moved (and re-branded) them, or not yet.
    const lookups: Array<[string, string]> = [[sourceOrgId, sourceBrandId], [targetOrgId, sourceBrandId]];
    if (targetBrandId && targetBrandId !== sourceBrandId) lookups.push([targetOrgId, targetBrandId]);
    const campaignIds = [...new Set((await Promise.all(
      lookups.map(([orgId, brandId]) => listSoloBrandCampaignIds(orgId, brandId)),
    )).flat())];

    const result = await transferBrand({ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId, campaignIds });

    if (result.coBrandedSkipped > 0) {
      console.warn(`[transactional-email-service] transfer-brand: ${result.coBrandedSkipped} co-branded email_events row(s) of org ${sourceOrgId} name brand ${sourceBrandId} AND another brand — left in the source org`);
    }
    console.log(`[transactional-email-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} ${sourceOrgId} -> ${targetOrgId} campaigns=${campaignIds.length} ${JSON.stringify(result.updatedTables)}`);

    res.json({ updatedTables: result.updatedTables });
  } catch (error: any) {
    console.error("[transactional-email-service] transfer-brand error:", error);
    res.status(500).json({ error: error.message || "Failed to transfer brand" });
  }
});

export default router;
