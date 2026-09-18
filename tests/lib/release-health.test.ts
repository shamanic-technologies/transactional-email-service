import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The module captures its gateway credentials at load, so the environment is
// set synchronously here and the module is pulled in dynamically afterwards.
// vi.stubEnv would fire too late: static imports evaluate before the test
// file's body runs.
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://localhost:9999";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "fake-email-gateway-key";

const { fetchDeliveryOutcomes } = await import("../../src/lib/release-health.js");
const { releaseOperationId } = await import("../../src/lib/release-operation.js");

const RELEASE_ID = "11111111-2222-4333-8444-555555555555";

function respond(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function matched(emailStats: Record<string, number>, messageCount = 1200) {
  return { matched: true, messageCount, transactional: { emailStats } };
}

describe("fetchDeliveryOutcomes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads this release's own outcomes, keyed on the handle every one of its messages carries", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(respond(matched({ sent: 1200, bounced: 14, unsubscribed: 9, delivered: 1186 })));

    const outcomes = await fetchDeliveryOutcomes(RELEASE_ID);

    expect(outcomes).toEqual({ sent: 1200, bounced: 14, unsubscribed: 9 });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/public/stats/by-operation");
    expect(String(url)).toContain(`operationId=${encodeURIComponent(releaseOperationId(RELEASE_ID))}`);
    // Never the release's own run: the run recorded against each message
    // downstream is a child run minted per send, so that question matches
    // nothing and answers a well-formed zero.
    expect(String(url)).not.toContain("runIds");
  });

  it("names the handle per release, never per list", () => {
    expect(releaseOperationId(RELEASE_ID)).toBe(`mailing-list-release-${RELEASE_ID}`);
  });

  it("reads a release with no bounces and no unsubscribes as zero of each, not as absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(matched({ sent: 800 })));

    expect(await fetchDeliveryOutcomes(RELEASE_ID)).toEqual({ sent: 800, bounced: 0, unsubscribed: 0 });
  });

  it("throws when the gateway matched no message — a question that found nothing is not a clean release", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond({ operationId: releaseOperationId(RELEASE_ID), matched: false, messageCount: 0 })
    );

    await expect(fetchDeliveryOutcomes(RELEASE_ID)).rejects.toThrow(/found nothing/);
  });

  it("throws when the provider's answer cannot be had, rather than reporting a healthy release", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond({ error: "upstream down" }, 502));

    await expect(fetchDeliveryOutcomes(RELEASE_ID)).rejects.toThrow(/502/);
  });

  it("throws on a matched answer carrying no sent count — a shape it cannot read is not a zero", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond({ matched: true, messageCount: 5, broadcast: { emailStats: { sent: 5 } } })
    );

    await expect(fetchDeliveryOutcomes(RELEASE_ID)).rejects.toThrow(/emailStats\.sent/);
  });
});
