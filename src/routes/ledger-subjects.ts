import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { LedgerSubjectsChecksRequestSchema } from "../schemas.js";
import { nameSubscribersAtApollo } from "../lib/ledger-subjects.js";
import { messageOf } from "../lib/db-error.js";

const router = Router();

router.post("/internal/ledger-subjects/checks", requireApiKey, async (req, res) => {
  const parsed = LedgerSubjectsChecksRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    res.json(await nameSubscribersAtApollo({ dryRun: parsed.data.dryRun }));
  } catch (error: any) {
    console.error("[transactional-email-service] ledger subjects (checks) error:", error);
    res.status(502).json({ error: messageOf(error) || "Naming subscribers at apollo-service failed" });
  }
});

export default router;
