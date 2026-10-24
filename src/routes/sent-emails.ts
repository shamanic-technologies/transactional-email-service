import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { SentEmailsQuerySchema } from "../schemas.js";
import { decodeCursor, listSentEmails } from "../lib/sent-emails.js";

const router = Router();

// Every transactional email sent to a client, for crm-service to show in the
// recipient's Unibox thread (TX-EMAIL-IN-UNIBOX-1024). Read-only.
router.get("/internal/sent-emails", requireApiKey, async (req, res, next) => {
  const parsed = SentEmailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const after = parsed.data.after === undefined ? null : decodeCursor(parsed.data.after);
  if (parsed.data.after !== undefined && after === null) {
    res.status(400).json({ error: "Invalid cursor: pass back a nextCursor this route returned" });
    return;
  }
  try {
    res.json(await listSentEmails({ after, limit: parsed.data.limit ?? 200 }));
  } catch (err) {
    next(err);
  }
});

export default router;
