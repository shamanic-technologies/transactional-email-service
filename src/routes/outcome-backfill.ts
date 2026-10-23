import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { OutcomeBackfillRequestSchema } from "../schemas.js";
import { backfillReleaseOutcomes } from "../lib/outcome-backfill.js";
import { messageOf } from "../lib/db-error.js";

const router = Router();

router.post("/internal/outcome-backfill", requireApiKey, async (req, res) => {
  const parsed = OutcomeBackfillRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    res.json(await backfillReleaseOutcomes({ dryRun: parsed.data.dryRun }));
  } catch (error: any) {
    console.error("[transactional-email-service] outcome backfill error:", error);
    res.status(502).json({ error: messageOf(error) || "Outcome backfill failed" });
  }
});

export default router;
