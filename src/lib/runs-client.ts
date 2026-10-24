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
  /** Acting user, when there is one. runs-service treats x-user-id as optional. */
  userId?: string;
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
  audienceId?: string;
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
  if (workflowHeaders?.audienceId) headers["x-audience-id"] = workflowHeaders.audienceId;

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
  identity: { orgId: string; userId?: string },
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

// ─── Platform runs (org-less) ────────────────────────────────────────────────
//
// A send with no organisation at all (POST /platform-orgless-send: a sign-up
// code mailed before any account exists) has no org to open a run under. It
// opens a platform run instead: no x-org-id, no x-user-id, so nothing on it can
// ever reach an org's usage total. runs-service requires x-service-name here.

function platformHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-Key": RUNS_SERVICE_API_KEY,
    "x-service-name": "transactional-email-service",
  };
}

async function platformRunsRequest<T>(path: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(`${RUNS_SERVICE_URL}${path}`, {
    method,
    headers: platformHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`runs-service ${method} ${path} failed: ${response.status} - ${errorText}`);
  }
  return response.json() as Promise<T>;
}

export async function createPlatformRun(params: { serviceName: string; taskName: string }): Promise<Run> {
  return platformRunsRequest<Run>("/v1/platform-runs", "POST", params);
}

export async function updatePlatformRun(runId: string, status: "completed" | "failed", error?: string): Promise<Run> {
  return platformRunsRequest<Run>(`/v1/platform-runs/${runId}`, "PATCH", { status, ...(error && { error }) });
}

// ─── Outcome backfill (COST-BACKFILL-1023) ──────────────────────────────────
//
// runs-service's batch door for declaring the outcomes of PAST runs, each run
// with its own `occurredAt` (see outcome-backfill.ts). Platform-authed: no
// x-org-id, x-service-name = the owner of every run declared. All or nothing
// per call; a replay answers 200 with every occurrence already recorded.

export interface BackfillOccurrence {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
}

export interface DeclareOutcomesBatchBody {
  runs: Array<{ runId: string; occurredAt: string; produced: BackfillOccurrence[] }>;
}

export interface DeclareOutcomesBatchResult {
  recordedCount: number;
  alreadyRecordedCount: number;
}

export async function declareOutcomesBatch(body: DeclareOutcomesBatchBody): Promise<DeclareOutcomesBatchResult> {
  return platformRunsRequest<DeclareOutcomesBatchResult>("/v1/platform-runs/outcomes/batch", "POST", body);
}

// ─── Subject equivalences (LEDGER-HISTORY-1024) ─────────────────────────────
//
// The owner of a subject states it is the same subject as one of another space
// (a subscriber of ours == a lead-service lead), so one `email_checked` is
// consumed under both and declared once. All or nothing per call: a refused
// item 422s the whole call with per-item reasons (see ledger-subjects.ts).

export interface SubjectEquivalence {
  subjectService: string;
  subjectId: string;
  targetService: string;
  targetId: string;
}

export interface EquivalenceRefusal {
  index: number;
  reason: string;
}

export class EquivalencesRefusedError extends Error {
  constructor(public readonly refusals: EquivalenceRefusal[]) {
    super(`runs-service refused ${refusals.length} subject equivalence(s)`);
    this.name = "EquivalencesRefusedError";
  }
}

export async function stateSubjectEquivalences(body: {
  items: SubjectEquivalence[];
  reason: string;
  statedBy: string;
}): Promise<{ recordedCount: number; alreadyRecordedCount: number }> {
  const path = "/v1/platform-runs/subject-equivalences";
  const response = await fetch(`${RUNS_SERVICE_URL}${path}`, {
    method: "POST",
    headers: platformHeaders(),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status === 422) {
    const parsed = JSON.parse(text) as { error?: string; details?: { refusals?: EquivalenceRefusal[] } };
    if (parsed.error === "invalid_equivalences" && Array.isArray(parsed.details?.refusals)) {
      throw new EquivalencesRefusedError(parsed.details.refusals);
    }
  }
  if (!response.ok) {
    throw new Error(`runs-service POST ${path} failed: ${response.status} - ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as { recordedCount: number; alreadyRecordedCount: number };
}
