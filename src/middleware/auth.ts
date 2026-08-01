import { Request, Response, NextFunction } from "express";

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string;
  if (!apiKey || apiKey !== process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * Identity available on a user-less (machine caller) request: the organisation is
 * known, the acting user and the caller's run are not.
 */
export interface PlatformIdentityLocals {
  orgId: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  brandIds?: string[];
  workflowSlug?: string;
  featureSlug?: string;
  audienceId?: string;
}

export interface IdentityLocals extends PlatformIdentityLocals {
  userId: string;
  runId: string;
}

function applyOptionalTrackingHeaders(req: Request, res: Response) {
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const brandIds = String(req.headers["x-brand-id"] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  const audienceId = req.headers["x-audience-id"] as string | undefined;
  if (campaignId) res.locals.campaignId = campaignId;
  if (brandIds.length) res.locals.brandIds = brandIds;
  if (workflowSlug) res.locals.workflowSlug = workflowSlug;
  if (featureSlug) res.locals.featureSlug = featureSlug;
  if (audienceId) res.locals.audienceId = audienceId;
}

export function requireIdentityHeaders(req: Request, res: Response, next: NextFunction) {
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const runId = req.headers["x-run-id"] as string;

  if (!orgId || !userId || !runId) {
    res.status(400).json({ error: "Missing required headers: x-org-id, x-user-id, and x-run-id" });
    return;
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;
  res.locals.runId = runId;

  applyOptionalTrackingHeaders(req, res);

  next();
}

/**
 * Organisation-only identity for machine callers that observe an event outside
 * our product (a Stripe webhook, a cron) and therefore have no acting user and
 * no parent run. x-user-id / x-run-id are honoured when present but never
 * required, and are never substituted with a placeholder when absent.
 */
export function requireOrgIdOnly(req: Request, res: Response, next: NextFunction) {
  const orgId = req.headers["x-org-id"] as string;

  if (!orgId) {
    res.status(400).json({ error: "Missing required header: x-org-id" });
    return;
  }

  res.locals.orgId = orgId;

  const userId = req.headers["x-user-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;
  if (userId) res.locals.userId = userId;
  if (runId) res.locals.runId = runId;

  applyOptionalTrackingHeaders(req, res);

  next();
}
