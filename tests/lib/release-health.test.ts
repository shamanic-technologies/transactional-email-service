import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The module captures its gateway credentials at load, so the environment is
// set synchronously here and the module is pulled in dynamically afterwards.
// vi.stubEnv would fire too late: static imports evaluate before the test
// file's body runs.
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://localhost:9999";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "fake-email-gateway-key";

const { fetchDeliveryOutcomes } = await import("../../src/lib/release-health.js");
const { releaseOperationId } = await import("../../src/lib/release-operation.js");

/** The run a release sends every one of its messages under. */
const RUN_ID = "11111111-2222-4333-8444-555555555555";

function respond(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function matched(emailStats: Record<string, number>, messagesMatched = 1200) {
  return { matched: true, messagesMatched, transactional: { emailStats } };
}

describe("fetchDeliveryOutcomes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads this release's own outcomes, keyed on the run every one of its messages is sent under", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(respond(matched({ sent: 1200, bounced: 14, unsubscribed: 9, delivered: 1186 })));

    const outcomes = await fetchDeliveryOutcomes(RUN_ID);

    expect(outcomes).toEqual({ sent: 1200, bounced: 14, unsubscribed: 9 });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/public/stats/by-operation");
    expect(String(url)).toContain(`operationRunId=${RUN_ID}`);
    // Never `runIds`, which on the general stats read means the CHILD run the
    // provider mints per send — the question that matched nothing and answered
    // a well-formed zero. And never the send tag, which is per-template in
    // storage and so answers for more releases than this one.
    expect(String(url)).not.toContain("runIds");
    expect(String(url)).not.toContain("mailing-list-release-");
  });

  it("names the archive tag per release, never per list", () => {
    expect(releaseOperationId(RUN_ID)).toBe(`mailing-list-release-${RUN_ID}`);
  });

  it("reads a release with no bounces and no unsubscribes as zero of each, not as absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(matched({ sent: 800 })));

    expect(await fetchDeliveryOutcomes(RUN_ID)).toEqual({ sent: 800, bounced: 0, unsubscribed: 0 });
  });

  it("throws when the gateway matched no message — a question that found nothing is not a clean release", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond({ operationRunId: RUN_ID, matched: false, messagesMatched: 0 })
    );

    await expect(fetchDeliveryOutcomes(RUN_ID)).rejects.toThrow(/found nothing/);
  });

  it("throws when the provider's answer cannot be had, rather than reporting a healthy release", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond({ error: "upstream down" }, 502));

    await expect(fetchDeliveryOutcomes(RUN_ID)).rejects.toThrow(/502/);
  });

  it("throws on a matched answer carrying no sent count — a shape it cannot read is not a zero", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond({ matched: true, messagesMatched: 5, broadcast: { emailStats: { sent: 5 } } })
    );

    await expect(fetchDeliveryOutcomes(RUN_ID)).rejects.toThrow(/emailStats\.sent/);
  });
});
