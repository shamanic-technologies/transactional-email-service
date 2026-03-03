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
  next();
}
