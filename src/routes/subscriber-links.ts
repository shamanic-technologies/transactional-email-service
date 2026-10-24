import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { resolveLinkId } from "../lib/subscriber-link-store.js";
import { messageOf } from "../lib/db-error.js";

const router = Router();

const STATUS_CODE = { valid: 200, tampered: 400, unknown: 404, revoked: 410 } as const;

/**
 * GET /internal/subscriber-links/:linkId — who a newsletter link's `dy_sub`
 * names. API key only (our own apps, server side): it turns an opaque id into
 * an email address, so it is never a public read.
 */
router.get("/internal/subscriber-links/:linkId", requireApiKey, async (req, res) => {
  try {
    const resolution = await resolveLinkId(String(req.params.linkId));
    res.status(STATUS_CODE[resolution.status]).json(resolution);
  } catch (error: any) {
    console.error("[transactional-email-service] subscriber link resolve error:", error);
    res.status(500).json({ error: messageOf(error) || "Failed to resolve subscriber link" });
  }
});

export default router;
