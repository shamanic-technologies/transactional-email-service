import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { MonitoringAlertsQuerySchema } from "../schemas.js";
import { readMonitoringAlerts } from "../lib/monitoring-alerts.js";

const router = Router();

// Monitoring alerts are recorded, never emailed (SIGNUP-EMAILS-1111): dashboard
// v2 Monitoring reads them here. Read-only.
router.get("/internal/monitoring-alerts", requireApiKey, async (req, res, next) => {
  const parsed = MonitoringAlertsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    res.json(await readMonitoringAlerts(parsed.data.days ?? 30));
  } catch (err) {
    next(err);
  }
});

export default router;
