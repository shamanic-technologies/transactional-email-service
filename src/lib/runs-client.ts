/**
 * HTTP client for runs-service
 * BLOCKING: must succeed before operations proceed
 */

const RUNS_SERVICE_URL =
  process.env.RUNS_SERVICE_URL || "http://localhost:3006";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Run {
  id: string;
  parentRunId: string | null;
  organizationId: string;
  userId: string | null;
  brandIds: string[] | null;
  campaignId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunParams {
  orgId: string;
  userId: string;
  serviceName: string;
  taskName: string;
  brandIds?: string[];
  campaignId?: string;
  parentRunId?: string;
  workflowHeaders?: WorkflowHeaders;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

export interface WorkflowHeaders {
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

async function runsRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; orgId?: string; userId?: string; runId?: string; workflowHeaders?: WorkflowHeaders } = {}
): Promise<T> {
  const { method = "GET", body, orgId, userId, runId, workflowHeaders } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": RUNS_SERVICE_API_KEY,
  };
  if (orgId) headers["x-org-id"] = orgId;
  if (userId) headers["x-user-id"] = userId;
  if (runId) headers["x-run-id"] = runId;
  if (workflowHeaders?.campaignId) headers["x-campaign-id"] = workflowHeaders.campaignId;
  if (workflowHeaders?.brandId) headers["x-brand-id"] = workflowHeaders.brandId;
  if (workflowHeaders?.workflowSlug) headers["x-workflow-slug"] = workflowHeaders.workflowSlug;
  if (workflowHeaders?.featureSlug) headers["x-feature-slug"] = workflowHeaders.featureSlug;

  const response = await fetch(`${RUNS_SERVICE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `runs-service ${method} ${path} failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<T>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function createRun(params: CreateRunParams): Promise<Run> {
  const { workflowHeaders, ...body } = params;
  return runsRequest<Run>("/v1/runs", {
    method: "POST",
    body,
    orgId: params.orgId,
    userId: params.userId,
    runId: params.parentRunId,
    workflowHeaders,
  });
}

export async function updateRun(
  runId: string,
  status: "completed" | "failed",
  identity: { orgId: string; userId: string },
  workflowHeaders?: WorkflowHeaders
): Promise<Run> {
  return runsRequest<Run>(`/v1/runs/${runId}`, {
    method: "PATCH",
    body: { status },
    orgId: identity.orgId,
    userId: identity.userId,
    runId,
    workflowHeaders,
  });
}
