import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.KEY_SERVICE_API_KEY = "test-key-service-key";
  process.env.KEY_SERVICE_URL = "https://key.test";
});

import {
  fetchSuppressed,
  resetSuppressionCache,
  MAX_FILTERED_LOOKUPS,
  SUPPRESSION_TTL_MS,
} from "../../src/lib/suppression.js";

const IDENTITY = { orgId: "org_456", userId: "user_staff" };

let fetchSpy: ReturnType<typeof vi.fn>;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function fail(status: number, body: unknown) {
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/**
 * key-service resolves the token and the stream, then Postmark answers about
 * the one address the query string names — the whole stream is never dumped.
 */
function wireHappyPath(suppressed: Record<string, string>) {
  fetchSpy.mockImplementation(async (url: string) => {
    if (url.includes("/keys/postmark/decrypt")) return ok({ provider: "postmark", key: "server-token", keySource: "platform" });
    if (url.includes("/keys/postmark-broadcast-stream/decrypt")) return ok({ provider: "postmark-broadcast-stream", key: "broadcast" });
    if (url.includes("/suppressions/dump")) {
      const entry = (address: string, reason: string) => ({
        EmailAddress: address,
        SuppressionReason: reason,
        Origin: "Recipient",
      });
      const asked = new URL(url).searchParams.get("EmailAddress");
      if (asked === null) {
        // Unfiltered: the whole broadcast stream comes back.
        return ok({ Suppressions: Object.entries(suppressed).map(([a, r]) => entry(a, r)) });
      }
      const reason = suppressed[asked.toLowerCase()];
      return ok({ Suppressions: reason ? [entry(asked, reason)] : [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const dumpCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes("/suppressions/dump"));
const keyCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes("/keys/"));

beforeEach(() => {
  resetSuppressionCache();
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchSuppressed", () => {
  it("marks an address on the broadcast stream's suppression list, with Postmark's reason", async () => {
    wireHappyPath({ "gone@example.com": "ManualSuppression", "bouncer@example.com": "HardBounce" });

    const lookup = await fetchSuppressed(IDENTITY, "/mailing-lists/:slug/subscribers", [
      "gone@example.com",
      "Bouncer@Example.com",
      "fine@example.com",
    ]);

    expect(lookup.isSuppressed("gone@example.com")).toBe(true);
    expect(lookup.reasonFor("gone@example.com")).toBe("ManualSuppression");
    expect(lookup.isSuppressed("BOUNCER@example.com")).toBe(true);
    expect(lookup.reasonFor("bouncer@example.com")).toBe("HardBounce");
    expect(lookup.isSuppressed("fine@example.com")).toBe(false);
    expect(lookup.reasonFor("fine@example.com")).toBeNull();
  });

  it("reads only the addresses it was given, never the whole stream", async () => {
    wireHappyPath({});
    await fetchSuppressed(IDENTITY, "/p", ["a@example.com", "b@example.com"]);

    expect(dumpCalls()).toHaveLength(2);
    for (const [url] of dumpCalls()) {
      expect(String(url)).toContain("EmailAddress=");
    }
    expect(dumpCalls().map(([url]) => new URL(String(url)).searchParams.get("EmailAddress")).sort()).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("takes one dump instead once the list outgrows a single wave of filtered lookups", async () => {
    const members = Array.from({ length: MAX_FILTERED_LOOKUPS + 1 }, (_, i) => `m${i}@example.com`);
    wireHappyPath({ "m7@example.com": "SpamComplaint" });

    const lookup = await fetchSuppressed(IDENTITY, "/p", members);

    expect(dumpCalls()).toHaveLength(1);
    expect(String(dumpCalls()[0][0])).not.toContain("EmailAddress");
    expect(lookup.isSuppressed("m7@example.com")).toBe(true);
    expect(lookup.reasonFor("m7@example.com")).toBe("SpamComplaint");
    expect(lookup.isSuppressed("m0@example.com")).toBe(false);
  });

  it("reads the stream Postmark actually sends on, using the resolved server token", async () => {
    wireHappyPath({});
    await fetchSuppressed(IDENTITY, "/mailing-lists/:slug/updates", ["someone@example.com"]);

    const [url, init] = dumpCalls()[0];
    expect(String(url)).toBe(
      "https://api.postmarkapp.com/message-streams/broadcast/suppressions/dump?EmailAddress=someone%40example.com"
    );
    expect(init.headers["X-Postmark-Server-Token"]).toBe("server-token");

    const keyCall = keyCalls().find(([u]) => String(u).includes("/keys/postmark/decrypt"))!;
    expect(keyCall[1].headers["x-org-id"]).toBe("org_456");
    expect(keyCall[1].headers["x-user-id"]).toBe("user_staff");
    expect(keyCall[1].headers["X-Caller-Path"]).toBe("/mailing-lists/:slug/updates");
  });

  it("touches the provider not at all when the list is empty", async () => {
    wireHappyPath({});
    await fetchSuppressed(IDENTITY, "/p", []);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves a second read inside the cache window without re-hitting the provider", async () => {
    wireHappyPath({ "gone@example.com": "HardBounce" });

    const first = await fetchSuppressed(IDENTITY, "/p", ["gone@example.com", "fine@example.com"]);
    expect(first.isSuppressed("gone@example.com")).toBe(true);

    const dumpsAfterFirst = dumpCalls().length;
    const keysAfterFirst = keyCalls().length;
    expect(dumpsAfterFirst).toBe(2);
    expect(keysAfterFirst).toBe(2);

    const second = await fetchSuppressed(IDENTITY, "/p", ["gone@example.com", "fine@example.com"]);

    expect(dumpCalls()).toHaveLength(dumpsAfterFirst);
    expect(keyCalls()).toHaveLength(keysAfterFirst);
    expect(second.isSuppressed("gone@example.com")).toBe(true);
    expect(second.reasonFor("gone@example.com")).toBe("HardBounce");
    expect(second.isSuppressed("fine@example.com")).toBe(false);
  });

  it("re-reads once the cached answer has aged past the window", async () => {
    vi.useFakeTimers();
    wireHappyPath({});

    await fetchSuppressed(IDENTITY, "/p", ["a@example.com"]);
    expect(dumpCalls()).toHaveLength(1);

    vi.advanceTimersByTime(SUPPRESSION_TTL_MS + 1);

    await fetchSuppressed(IDENTITY, "/p", ["a@example.com"]);
    expect(dumpCalls()).toHaveLength(2);
  });

  it("reads only the addresses it has not already cached", async () => {
    wireHappyPath({});

    await fetchSuppressed(IDENTITY, "/p", ["a@example.com"]);
    expect(dumpCalls()).toHaveLength(1);

    await fetchSuppressed(IDENTITY, "/p", ["a@example.com", "b@example.com"]);
    expect(dumpCalls()).toHaveLength(2);
    expect(new URL(String(dumpCalls()[1][0])).searchParams.get("EmailAddress")).toBe("b@example.com");
  });

  it("re-checks every address against the provider when the caller accepts no staleness", async () => {
    const suppressed: Record<string, string> = {};
    wireHappyPath(suppressed);

    const read = await fetchSuppressed(IDENTITY, "/p", ["leaver@example.com"]);
    expect(read.isSuppressed("leaver@example.com")).toBe(false);

    // They opt out a moment later, while the read's answer is still cached.
    suppressed["leaver@example.com"] = "ManualSuppression";

    const send = await fetchSuppressed(IDENTITY, "/p", ["leaver@example.com"], { maxAgeMs: 0 });
    expect(send.isSuppressed("leaver@example.com")).toBe(true);
    expect(send.reasonFor("leaver@example.com")).toBe("ManualSuppression");
    expect(dumpCalls()).toHaveLength(2);

    // …and the fresh answer replaces the stale one for subsequent reads.
    const after = await fetchSuppressed(IDENTITY, "/p", ["leaver@example.com"]);
    expect(after.isSuppressed("leaver@example.com")).toBe(true);
    expect(dumpCalls()).toHaveLength(2);
  });

  it("refuses to answer for an address it was never asked to read", async () => {
    wireHappyPath({});
    const lookup = await fetchSuppressed(IDENTITY, "/p", ["asked@example.com"]);

    expect(() => lookup.isSuppressed("never-asked@example.com")).toThrow("was never read");
  });

  it("throws when key-service cannot resolve the Postmark token", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/keys/postmark/decrypt")) return fail(404, { error: "not found" });
      return ok({ key: "broadcast" });
    });

    await expect(fetchSuppressed(IDENTITY, "/p", ["a@example.com"])).rejects.toThrow(
      "key-service GET /keys/postmark/decrypt failed: 404"
    );
  });

  it("throws when Postmark refuses the read — never silently reports everyone subscribed", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/keys/")) return ok({ key: "x" });
      return fail(401, { Message: "unauthorized" });
    });

    await expect(fetchSuppressed(IDENTITY, "/p", ["a@example.com"])).rejects.toThrow(
      "Postmark suppression dump failed (401)"
    );
  });

  it("throws when Postmark returns no Suppressions array", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/keys/")) return ok({ key: "x" });
      return ok({ unexpected: true });
    });

    await expect(fetchSuppressed(IDENTITY, "/p", ["a@example.com"])).rejects.toThrow("no Suppressions array");
  });

  it("caches nothing from a failed read, so the next read asks the provider again", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("/keys/")) return ok({ key: "x" });
      return fail(500, { Message: "boom" });
    });

    await expect(fetchSuppressed(IDENTITY, "/p", ["a@example.com"])).rejects.toThrow("(500)");
    expect(dumpCalls()).toHaveLength(1);

    await expect(fetchSuppressed(IDENTITY, "/p", ["a@example.com"])).rejects.toThrow("(500)");
    expect(dumpCalls()).toHaveLength(2);
  });
});
