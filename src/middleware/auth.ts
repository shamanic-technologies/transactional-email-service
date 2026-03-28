import { Request, Response, NextFunction } from "express";

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string;
  if (!apiKey || apiKey !== process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export interface IdentityLocals {
  orgId: string;
  userId: string;
  runId: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
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

  // Optional workflow tracking headers
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const brandId = req.headers["x-brand-id"] as string | undefined;
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  if (campaignId) res.locals.campaignId = campaignId;
  if (brandId) res.locals.brandId = brandId;
  if (workflowSlug) res.locals.workflowSlug = workflowSlug;
  if (featureSlug) res.locals.featureSlug = featureSlug;

  next();
}
