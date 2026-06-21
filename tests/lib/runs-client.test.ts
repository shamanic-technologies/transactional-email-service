import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.RUNS_SERVICE_URL = "https://runs.test";
  process.env.RUNS_SERVICE_API_KEY = "test-runs-key";
});

import { createRun, updateRun } from "../../src/lib/runs-client.js";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ id: "run-456" }),
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRun", () => {
  it("forwards x-audience-id header when audienceId is provided in workflowHeaders", async () => {
    await createRun({
      orgId: "org_123",
      userId: "user_456",
      serviceName: "transactional-email-service",
      taskName: "email-welcome",
      parentRunId: "run_caller_001",
      workflowHeaders: { audienceId: "aud_priority_1", featureSlug: "sales-cold-email-outreach" },
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://runs.test/v1/runs");
    expect(options.headers["x-audience-id"]).toBe("aud_priority_1");
    expect(options.headers["x-feature-slug"]).toBe("sales-cold-email-outreach");
  });

  it("omits x-audience-id header when audienceId is absent", async () => {
    await createRun({
      orgId: "org_123",
      userId: "user_456",
      serviceName: "transactional-email-service",
      taskName: "email-welcome",
      parentRunId: "run_caller_001",
      workflowHeaders: { featureSlug: "lifecycle" },
    });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-audience-id"]).toBeUndefined();
  });
});

describe("updateRun", () => {
  it("forwards x-audience-id header when audienceId is provided", async () => {
    await updateRun(
      "run-456",
      "completed",
      { orgId: "org_123", userId: "user_456" },
      { audienceId: "aud_priority_1" }
    );

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-audience-id"]).toBe("aud_priority_1");
  });
});
