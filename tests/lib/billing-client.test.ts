import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
});

import { authorizeCredits, EMAIL_COST_NAME, EMAIL_COST_QUANTITY } from "../../src/lib/billing-client.js";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorizeCredits", () => {
  it("returns sufficient: true when balance is enough", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sufficient: true, balance_cents: 500, required_cents: 1, billing_mode: "payg" }),
    });

    const result = await authorizeCredits({
      items: [{ costName: EMAIL_COST_NAME, quantity: EMAIL_COST_QUANTITY }],
      description: "transactional-email — welcome",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_789",
    });

    expect(result.sufficient).toBe(true);
    expect(result.balance_cents).toBe(500);

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain("/v1/credits/authorize");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body);
    expect(body.items).toEqual([{ costName: "postmark-email-send", quantity: 1 }]);
    expect(body.description).toBe("transactional-email — welcome");

    expect(options.headers["X-API-Key"]).toBe("test-billing-key");
    expect(options.headers["x-org-id"]).toBe("org_123");
    expect(options.headers["x-user-id"]).toBe("user_456");
    expect(options.headers["x-run-id"]).toBe("run_789");
  });

  it("returns sufficient: false when balance is insufficient", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sufficient: false, balance_cents: 0, required_cents: 1, billing_mode: "trial" }),
    });

    const result = await authorizeCredits({
      items: [{ costName: EMAIL_COST_NAME, quantity: EMAIL_COST_QUANTITY }],
      description: "transactional-email — welcome",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_789",
    });

    expect(result.sufficient).toBe(false);
    expect(result.balance_cents).toBe(0);
  });

  it("throws when billing-service returns non-2xx", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(
      authorizeCredits({
        items: [{ costName: EMAIL_COST_NAME, quantity: EMAIL_COST_QUANTITY }],
        description: "transactional-email — welcome",
        orgId: "org_123",
        userId: "user_456",
        runId: "run_789",
      })
    ).rejects.toThrow("billing-service POST /v1/credits/authorize failed: 500");
  });

  it("forwards workflow headers when provided", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sufficient: true, balance_cents: 100, required_cents: 1, billing_mode: "payg" }),
    });

    await authorizeCredits({
      items: [{ costName: EMAIL_COST_NAME, quantity: EMAIL_COST_QUANTITY }],
      description: "transactional-email — welcome",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_789",
      workflowHeaders: {
        campaignId: "camp_123",
        brandId: "brand_456",
        workflowName: "onboarding-flow",
      },
    });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-campaign-id"]).toBe("camp_123");
    expect(options.headers["x-brand-id"]).toBe("brand_456");
    expect(options.headers["x-workflow-name"]).toBe("onboarding-flow");
  });

  it("omits workflow headers when not provided", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sufficient: true, balance_cents: 100, required_cents: 1, billing_mode: "payg" }),
    });

    await authorizeCredits({
      items: [{ costName: EMAIL_COST_NAME, quantity: EMAIL_COST_QUANTITY }],
      description: "transactional-email — welcome",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_789",
    });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-campaign-id"]).toBeUndefined();
    expect(options.headers["x-brand-id"]).toBeUndefined();
    expect(options.headers["x-workflow-name"]).toBeUndefined();
  });
});
