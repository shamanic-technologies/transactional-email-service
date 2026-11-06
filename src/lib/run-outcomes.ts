/**
 * runs-service's org door for declaring what a run produced and consumed
 * (`POST /v1/runs/{id}/outcomes`). Own module because the integration suites
 * `vi.mock` the whole of runs-client.js (a helper exported from there comes back
 * undefined inside the code under test).
 *
 * `x-service-name` is this service: runs-service lets only a run's own service
 * date a fact before the run's start, which a spend-free Units run does for
 * every email sent before it was opened (newsletter-units.ts).
 */

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "http://localhost:3006";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";

export interface OutcomeOccurrence {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
}

export interface RunOutcomesBody {
  produced?: OutcomeOccurrence[];
  consumed?: OutcomeOccurrence[];
  /** ISO instant the facts happened (the send). */
  occurredAt?: string;
}

export interface RunOutcomesResult {
  recordedCount: number;
  alreadyRecordedCount: number;
}

/** Fails loud: any non-2xx throws with runs-service's answer. A replay answers 200 `already_recorded`. */
export async function declareRunOutcomes(
  runId: string,
  identity: { orgId: string; userId?: string },
  body: RunOutcomesBody
): Promise<RunOutcomesResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": RUNS_SERVICE_API_KEY,
    "x-org-id": identity.orgId,
    "x-run-id": runId,
    "x-service-name": "transactional-email-service",
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  const path = `/v1/runs/${runId}/outcomes`;
  const response = await fetch(`${RUNS_SERVICE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`runs-service POST ${path} failed: ${response.status} - ${text.slice(0, 500)}`);
  }
  const parsed = JSON.parse(text) as Partial<RunOutcomesResult>;
  return { recordedCount: Number(parsed.recordedCount ?? 0), alreadyRecordedCount: Number(parsed.alreadyRecordedCount ?? 0) };
}
