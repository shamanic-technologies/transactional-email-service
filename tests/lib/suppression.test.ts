import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.KEY_SERVICE_API_KEY = "test-key-service-key";
  process.env.KEY_SERVICE_URL = "https://key.test";
});

import { fetchSuppressed } from "../../src/lib/suppression.js";

const IDENTITY = { orgId: "org_456", userId: "user_staff" };

let fetchSpy: ReturnType<typeof vi.fn>;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function fail(status: number, body: unknown) {
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** key-service resolves the token and the stream, then Postmark serves the dump. */
function wireHappyPath(suppressions: unknown[]) {
  fetchSpy.mockImplementation(async (url: string) => {
    if (url.includes("/keys/postmark/decrypt")) return ok({ provider: "postmark", key: "server-token", keySource: "platform" });
    if (url.includes("/keys/postmark-broadcast-stream/decrypt")) return ok({ provider: "postmark-broadcast-stream", key: "broadcast" });
    if (url.includes("/suppressions/dump")) return ok({ Suppressions: suppressions });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSuppressed", () => {
  it("marks an address on the broadcast stream's suppression list, with Postmark's reason", async () => {
    wireHappyPath([
      { EmailAddress: "gone@example.com", SuppressionReason: "ManualSuppression", Origin: "Recipient" },
      { EmailAddress: "Bouncer@Example.com", SuppressionReason: "HardBounce", Origin: "Recipient" },
    ]);

    const lookup = await fetchSuppressed(IDENTITY, "/mailing-lists/:slug/subscribers");

    expect(lookup.isSuppressed("gone@example.com")).toBe(true);
    expect(lookup.reasonFor("gone@example.com")).toBe("ManualSuppression");
    expect(lookup.isSuppressed("BOUNCER@example.com")).toBe(true);
    expect(lookup.reasonFor("bouncer@example.com")).toBe("HardBounce");
    expect(lookup.isSuppressed("fine@example.com")).toBe(false);
    expect(lookup.reasonFor("fine@example.com")).toBeNull();
  });

  it("reads the stream Postmark actually sends on, using the resolved server token", async () => {
    wireHappyPath([]);
    await fetchSuppressed(IDENTITY, "/mailing-lists/:slug/updates");

    const dumpCall = fetchSpy.mock.calls.find(([url]) => String(url).includes("/suppressions/dump"))!;
    expect(dumpCall[0]).toBe("https://api.postmarkapp.com/message-streams/broadcast/suppressions/dump");
    expect(dumpCall[1].headers["X-Postmark-Server-Token"]).toBe("server-token");

    const keyCall = fetchSpy.mock.calls.find(([url]) => String(url).includes("/keys/postmark/decrypt"))!;
    expect(keyCall[1].headers["x-org-id"]).toBe("org_456");
    expect(keyCall[1].headers["x-user-id"]).toBe("user_staff");
    expect(keyCall[1].headers["X-Caller-Path"]).toBe("/mailing-lists/:slug/updates");
  });

  it("returns an empty suppression set when the stream suppresses nobody", async () => {
    wireHappyPath([]);
    const lookup = await fetchSuppressed(IDENTITY, "/p");
    expect(lookup.isSuppressed("anyone@example.com")).toBe(false);
  });

  it("throws when key-service cannot resolve the Postmark token", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/keys/postmark/decrypt")) return fail(404, { error: "not found" });
      return ok({ key: "broadcast" });
    });

    await expect(fetchSuppressed(IDENTITY, "/p")).rejects.toThrow("key-service GET /keys/postmark/decrypt failed: 404");
  });

  it("throws when Postmark refuses the dump — never silently reports everyone subscribed", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/keys/")) return ok({ key: "x" });
      return fail(401, { Message: "unauthorized" });
    });

    await expect(fetchSuppressed(IDENTITY, "/p")).rejects.toThrow("Postmark suppression dump failed (401)");
  });

  it("throws when Postmark returns no Suppressions array", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/keys/")) return ok({ key: "x" });
      return ok({ unexpected: true });
    });

    await expect(fetchSuppressed(IDENTITY, "/p")).rejects.toThrow("no Suppressions array");
  });
});
