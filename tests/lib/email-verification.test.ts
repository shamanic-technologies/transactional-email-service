import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchVerdicts, VerificationUnavailableError } from "../../src/lib/email-verification.js";

const RELEASE = {
  id: "rel-1",
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
  brandIds: ["b-1"],
  campaignId: null,
  audienceId: null,
  featureSlug: null,
  workflowSlug: null,
} as any;

const fetchMock = vi.fn();

function answer(status: number, body: unknown) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.APOLLO_SERVICE_URL = "http://apollo";
  process.env.APOLLO_SERVICE_API_KEY = "k";
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchVerdicts", () => {
  it("asks apollo-service under the release's identity and keys verdicts by lower-cased address", async () => {
    fetchMock.mockResolvedValue(
      answer(200, {
        results: [
          { email: "a@x.com", verdict: "valid", verificationId: "v1" },
          { email: "b@x.com", verdict: "catch_all", verificationId: "v2" },
        ],
      })
    );
    const map = await fetchVerdicts(RELEASE, ["A@x.com", "b@x.com"]);
    expect(map.get("a@x.com")).toEqual({ email: "a@x.com", verdict: "valid", verificationId: "v1" });
    expect(map.get("b@x.com")?.verdict).toBe("catch_all");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://apollo/email-verifications");
    expect(init.headers).toMatchObject({ "x-api-key": "k", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1", "x-brand-id": "b-1" });
    expect(JSON.parse(init.body).emails).toEqual(["A@x.com", "b@x.com"]);
  });

  it("throws on a non-2xx answer", async () => {
    fetchMock.mockResolvedValue(answer(502, { type: "email_verification", error: "boom" }));
    await expect(fetchVerdicts(RELEASE, ["a@x.com"])).rejects.toBeInstanceOf(VerificationUnavailableError);
  });

  it("throws when an address comes back without a verdict", async () => {
    fetchMock.mockResolvedValue(answer(200, { results: [{ email: "a@x.com", verdict: "valid", verificationId: "v1" }] }));
    await expect(fetchVerdicts(RELEASE, ["a@x.com", "b@x.com"])).rejects.toThrow(/no verdict returned/);
  });

  it("throws on a verdict word it does not know, rather than guessing", async () => {
    fetchMock.mockResolvedValue(answer(200, { results: [{ email: "a@x.com", verdict: "deliverable", verificationId: "v1" }] }));
    await expect(fetchVerdicts(RELEASE, ["a@x.com"])).rejects.toThrow(/malformed/);
  });

  it("throws when apollo-service is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchVerdicts(RELEASE, ["a@x.com"])).rejects.toThrow(/unreachable/);
  });

  it("throws when it is not configured, before calling anything", async () => {
    delete process.env.APOLLO_SERVICE_URL;
    await expect(fetchVerdicts(RELEASE, ["a@x.com"])).rejects.toThrow(/APOLLO_SERVICE_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("splits a large set into chunks apollo-service accepts", async () => {
    fetchMock.mockImplementation(async (_u: string, init: any) =>
      answer(200, { results: JSON.parse(init.body).emails.map((e: string) => ({ email: e, verdict: "valid", verificationId: e })) })
    );
    const emails = Array.from({ length: 120 }, (_, i) => `p${i}@x.com`);
    const map = await fetchVerdicts(RELEASE, emails);
    expect(map.size).toBe(120);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).emails.length)).toEqual([50, 50, 20]);
  });
});
