import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/index.js", () => ({ sql: vi.fn(), db: {} }));
vi.mock("../../src/lib/runs-client.js", () => ({ declareOutcomesBatch: vi.fn() }));

import { sql } from "../../src/db/index.js";
import { declareOutcomesBatch } from "../../src/lib/runs-client.js";
import {
  planBackfillCalls,
  backfillReleaseOutcomes,
  MAX_OCCURRENCES_PER_CALL,
  type PastSend,
} from "../../src/lib/outcome-backfill.js";

const RUN_A = "aaaaaaaa-0000-4000-a000-000000000000";
const RUN_B = "bbbbbbbb-0000-4000-a000-000000000000";

const send = (runId: string, subscriberId: string, at: string): PastSend => ({ runId, subscriberId, settledAt: new Date(at) });

describe("planBackfillCalls", () => {
  it("cuts one call per release run x UTC day, stamped with its earliest send", () => {
    const calls = planBackfillCalls([
      send(RUN_A, "s2", "2026-10-12T23:59:00Z"),
      send(RUN_A, "s1", "2026-10-12T11:00:00Z"),
      send(RUN_A, "s3", "2026-10-13T00:01:00Z"),
      send(RUN_B, "s1", "2026-10-12T12:00:00Z"),
    ]);
    expect(calls).toEqual([
      { runId: RUN_A, occurredAt: "2026-10-12T11:00:00.000Z", subscriberIds: ["s1", "s2"] },
      { runId: RUN_A, occurredAt: "2026-10-13T00:01:00.000Z", subscriberIds: ["s3"] },
      { runId: RUN_B, occurredAt: "2026-10-12T12:00:00.000Z", subscriberIds: ["s1"] },
    ]);
  });

  it("never puts more than runs-service's per-call ceiling in one call", () => {
    const sends = Array.from({ length: MAX_OCCURRENCES_PER_CALL * 2 + 5 }, (_, i) =>
      send(RUN_A, `s${String(i).padStart(5, "0")}`, "2026-10-12T10:00:00Z"));
    const calls = planBackfillCalls(sends);
    expect(calls.map((c) => c.subscriberIds.length)).toEqual([MAX_OCCURRENCES_PER_CALL, MAX_OCCURRENCES_PER_CALL, 5]);
    expect(new Set(calls.flatMap((c) => c.subscriberIds)).size).toBe(sends.length);
  });

  it("is deterministic whatever the input order, so a re-run sends the same calls", () => {
    const sends = [send(RUN_B, "x", "2026-10-01T01:00:00Z"), send(RUN_A, "y", "2026-10-02T01:00:00Z"), send(RUN_A, "z", "2026-10-02T01:00:00Z")];
    expect(planBackfillCalls(sends)).toEqual(planBackfillCalls([...sends].reverse()));
  });
});

describe("backfillReleaseOutcomes", () => {
  beforeEach(() => {
    vi.mocked(sql).mockReset().mockResolvedValue([
      { run_id: RUN_A, subscriber_id: "sub-1", settled_at: new Date("2026-10-12T11:00:00Z") },
      { run_id: RUN_A, subscriber_id: "sub-2", settled_at: new Date("2026-10-12T12:00:00Z") },
    ] as any);
    vi.mocked(declareOutcomesBatch).mockReset().mockResolvedValue({ recordedCount: 2, alreadyRecordedCount: 0 });
  });

  it("declares message_sent per subscriber on the release run, with the send's instant, nothing consumed", async () => {
    const report = await backfillReleaseOutcomes({ dryRun: false });
    expect(declareOutcomesBatch).toHaveBeenCalledWith({
      runs: [
        {
          runId: RUN_A,
          occurredAt: "2026-10-12T11:00:00.000Z",
          produced: [
            { outcomeKey: "message_sent", subjectService: "transactional-email-service", subjectId: "sub-1" },
            { outcomeKey: "message_sent", subjectService: "transactional-email-service", subjectId: "sub-2" },
          ],
        },
      ],
    });
    expect(report).toEqual({ dryRun: false, releaseRuns: 1, occurrences: 2, calls: 1, recorded: 2, alreadyRecorded: 0 });
  });

  it("a dry run counts and writes nothing", async () => {
    const report = await backfillReleaseOutcomes({ dryRun: true });
    expect(declareOutcomesBatch).not.toHaveBeenCalled();
    expect(report).toMatchObject({ dryRun: true, occurrences: 2, calls: 1, recorded: 0 });
  });

  it("fails loud when runs-service refuses", async () => {
    vi.mocked(declareOutcomesBatch).mockRejectedValue(new Error("runs-service POST /v1/platform-runs/outcomes/batch failed: 422"));
    await expect(backfillReleaseOutcomes({ dryRun: false })).rejects.toThrow("422");
  });
});
