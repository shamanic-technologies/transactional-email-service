import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The module captures its gateway credentials at load, so the environment is
// set synchronously here and the module is pulled in dynamically afterwards.
// vi.stubEnv would fire too late: static imports evaluate before the test
// file's body runs.
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://localhost:9999";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "fake-email-gateway-key";

const { fetchDeliveryOutcomes } = await import("../../src/lib/release-health.js");

const OPERATION_ID = "mailing-list-release-11111111-2222-4333-8444-555555555555";

function respond(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("fetchDeliveryOutcomes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads this release's own outcomes, keyed on the tag every one of its messages carries", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond({
        operationId: OPERATION_ID,
        matched: true,
        messageCount: 1200,
        transactional: {
          recipientStats: { contacted: 1200, sent: 1200 },
          emailStats: { sent: 1200, bounced: 14, unsubscribed: 9, delivered: 1186 },
        },
      })
    );

    const outcomes = await fetchDeliveryOutcomes(OPERATION_ID);

    expect(outcomes).toEqual({ sent: 1200, bounced: 14, unsubscribed: 9 });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/public/stats/by-operation");
    expect(String(url)).toContain(`operationId=${encodeURIComponent(OPERATION_ID)}`);
  });

  it("reads a release with no bounces and no unsubscribes as zero of each, not as absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond({ operationId: OPERATION_ID, matched: true, messageCount: 800, transactional: { emailStats: { sent: 800 } } })
    );

    expect(await fetchDeliveryOutcomes(OPERATION_ID)).toEqual({ sent: 800, bounced: 0, unsubscribed: 0 });
  });

  it("answers no-evidence-yet when nothing is recorded under the operation, which is not a zero", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond({ operationId: OPERATION_ID, matched: false, messageCount: 0 })
    );

    expect(await fetchDeliveryOutcomes(OPERATION_ID)).toBeNull();
  });

  it("throws when the provider's answer cannot be had, rather than reporting a healthy release", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond({ error: "upstream down" }, 502));

    await expect(fetchDeliveryOutcomes(OPERATION_ID)).rejects.toThrow(/502/);
  });

  it("throws on a match carrying no sent count — a shape it cannot read is not a zero", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond({ operationId: OPERATION_ID, matched: true, messageCount: 5, transactional: {} })
    );

    await expect(fetchDeliveryOutcomes(OPERATION_ID)).rejects.toThrow(/emailStats\.sent/);
  });
});
