import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { store, dbMock } = vi.hoisted(() => {
  process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "test-api-key";
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-service-key";

  /**
   * Table-aware fake of the drizzle chains the route uses. Filters (`where`)
   * are not interpreted — each scenario seeds exactly the rows the route
   * should see, and the assertions are on what the route writes and answers.
   */
  const store: {
    list: { id: string; slug: string } | null;
    subscribers: Array<{ id: string; listId: string; email: string; createdAt: Date }>;
    updates: any[];
    inserted: { subscribers: any[]; updates: any[]; lists: any[] };
    conflictedSubscribers: Set<string>;
    deleted: any[];
    deleteReturns: any[];
  } = {
    list: null,
    subscribers: [],
    updates: [],
    inserted: { subscribers: [], updates: [], lists: [] },
    conflictedSubscribers: new Set(),
    deleted: [],
    deleteReturns: [],
  };

  const tableName = (table: any): string => {
    const symbols = Object.getOwnPropertySymbols(table);
    for (const s of symbols) {
      const value = (table as any)[s];
      if (typeof value === "string") return value;
    }
    return "unknown";
  };

  const dbMock = {
    select: () => ({
      from: (table: any) => {
        const name = tableName(table);
        const rows =
          name === "mailing_lists"
            ? store.list
              ? [store.list]
              : []
            : name === "mailing_list_subscribers"
              ? store.subscribers
              : store.updates;
        const result = {
          where: () => ({
            limit: async () => rows,
            orderBy: async () => rows,
          }),
        };
        return result;
      },
    }),
    insert: (table: any) => {
      const name = tableName(table);
      return {
        values: (values: any) => ({
          onConflictDoUpdate: () => ({
            returning: async () => {
              store.inserted.lists.push(values);
              if (!store.list) store.list = { id: "list-1", slug: values.slug };
              return [store.list];
            },
          }),
          onConflictDoNothing: () => ({
            returning: async () => {
              if (store.conflictedSubscribers.has(values.email)) return [];
              store.inserted.subscribers.push(values);
              return [{ id: `sub-${store.inserted.subscribers.length}`, ...values }];
            },
          }),
          returning: async () => {
            store.inserted.updates.push(values);
            return [{ id: "update-1", ...values }];
          },
        }),
      };
    },
    delete: () => ({
      where: () => ({
        returning: async () => store.deleteReturns,
      }),
    }),
  };

  return { store, dbMock };
});

vi.mock("../../src/db/index.js", () => ({ db: dbMock }));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-broadcast-1" }),
  updateRun: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/email-gateway.js", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/suppression.js", () => ({
  fetchSuppressed: vi.fn().mockResolvedValue({ isSuppressed: () => false, reasonFor: () => null }),
}));

import request from "supertest";
import express from "express";
import mailingListsRoutes from "../../src/routes/mailing-lists.js";
import { sendEmail } from "../../src/lib/email-gateway.js";
import { fetchSuppressed } from "../../src/lib/suppression.js";
import { updateRun } from "../../src/lib/runs-client.js";

const app = express();
app.use(express.json());
app.use(mailingListsRoutes);

const AUTH = { "X-API-Key": "test-service-key", "x-org-id": "org_456", "x-user-id": "user_staff" };

function seedList(emails: string[]) {
  store.list = { id: "list-1", slug: "investors" };
  store.subscribers = emails.map((email, i) => ({
    id: `sub-${i}`,
    listId: "list-1",
    email,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  store.list = null;
  store.subscribers = [];
  store.updates = [];
  store.inserted = { subscribers: [], updates: [], lists: [] };
  store.conflictedSubscribers = new Set();
  store.deleteReturns = [];
  (sendEmail as any).mockResolvedValue(undefined);
  (fetchSuppressed as any).mockResolvedValue({ isSuppressed: () => false, reasonFor: () => null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("rejects a request with no API key", async () => {
    const res = await request(app).get("/mailing-lists/investors/subscribers").set("x-org-id", "org_456");
    expect(res.status).toBe(401);
  });

  it("rejects a request with no organisation", async () => {
    const res = await request(app).get("/mailing-lists/investors/subscribers").set("X-API-Key", "test-service-key");
    expect(res.status).toBe(400);
  });

  it("rejects a read with no acting staff user", async () => {
    seedList(["a@example.com"]);
    const res = await request(app)
      .get("/mailing-lists/investors/subscribers")
      .set({ "X-API-Key": "test-service-key", "x-org-id": "org_456" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-user-id");
  });

  it("rejects a send with no acting staff user", async () => {
    seedList(["a@example.com"]);
    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set({ "X-API-Key": "test-service-key", "x-org-id": "org_456" })
      .send({ subject: "s", body: "b" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-user-id");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects a malformed slug", async () => {
    const res = await request(app).get("/mailing-lists/Investors!/subscribers").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid list slug");
  });
});

describe("GET /mailing-lists/:slug/subscribers", () => {
  it("404s for a list that does not exist", async () => {
    const res = await request(app).get("/mailing-lists/investors/subscribers").set(AUTH);
    expect(res.status).toBe(404);
  });

  it("states opt-out per entry, read live from the provider", async () => {
    seedList(["a@example.com", "gone@example.com"]);
    (fetchSuppressed as any).mockResolvedValue({
      isSuppressed: (email: string) => email === "gone@example.com",
      reasonFor: (email: string) => (email === "gone@example.com" ? "ManualSuppression" : null),
    });

    const res = await request(app).get("/mailing-lists/investors/subscribers").set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.subscribers).toEqual([
      { email: "a@example.com", optedOut: false, optedOutReason: null, addedAt: "2026-01-01T00:00:00.000Z" },
      { email: "gone@example.com", optedOut: true, optedOutReason: "ManualSuppression", addedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("asks the provider only about the addresses on the list", async () => {
    seedList(["a@example.com", "gone@example.com"]);

    await request(app).get("/mailing-lists/investors/subscribers").set(AUTH);

    const [, callerPath, emails] = (fetchSuppressed as any).mock.calls[0];
    expect(callerPath).toBe("/mailing-lists/:slug/subscribers");
    expect(emails).toEqual(["a@example.com", "gone@example.com"]);
  });

  it("fails loud when provider suppression state cannot be read", async () => {
    seedList(["a@example.com"]);
    (fetchSuppressed as any).mockRejectedValue(new Error("Postmark suppression dump failed (500): boom"));

    const res = await request(app).get("/mailing-lists/investors/subscribers").set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Postmark suppression dump failed");
  });
});

describe("POST /mailing-lists/:slug/subscribers", () => {
  it("adds valid addresses from a messy blob and reports the rejects", async () => {
    const res = await request(app)
      .post("/mailing-lists/investors/subscribers")
      .set(AUTH)
      .send({ raw: "Ada <ada@example.com>; bob@example.com,\nnot-an-email\nada@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.added).toEqual(["ada@example.com", "bob@example.com"]);
    expect(res.body.skipped).toEqual(["ada@example.com"]);
    expect(res.body.rejected).toEqual([{ value: "not-an-email", reason: "not a valid email address" }]);
  });

  it("is a no-op when the same blob is pasted again", async () => {
    store.conflictedSubscribers = new Set(["ada@example.com", "bob@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/subscribers")
      .set(AUTH)
      .send({ raw: "ada@example.com, bob@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.added).toEqual([]);
    expect(res.body.skipped).toEqual(["ada@example.com", "bob@example.com"]);
    expect(store.inserted.subscribers).toEqual([]);
  });

  it("rejects an empty blob", async () => {
    const res = await request(app).post("/mailing-lists/investors/subscribers").set(AUTH).send({ raw: "" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /mailing-lists/:slug/subscribers", () => {
  it("removes an address", async () => {
    seedList(["ada@example.com"]);
    store.deleteReturns = [{ id: "sub-0", email: "ada@example.com" }];

    const res = await request(app)
      .delete("/mailing-lists/investors/subscribers")
      .query({ email: "Ada@Example.com" })
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "investors", email: "ada@example.com", removed: true });
  });

  it("404s when the address is not on the list", async () => {
    seedList(["ada@example.com"]);
    store.deleteReturns = [];

    const res = await request(app)
      .delete("/mailing-lists/investors/subscribers")
      .query({ email: "nobody@example.com" })
      .set(AUTH);

    expect(res.status).toBe(404);
  });

  it("400s with no email parameter", async () => {
    seedList(["ada@example.com"]);
    const res = await request(app).delete("/mailing-lists/investors/subscribers").set(AUTH);
    expect(res.status).toBe(400);
  });
});

describe("POST /mailing-lists/:slug/updates", () => {
  it("sends one message per recipient, from kevin@distribute.you, with no other recipient in it", async () => {
    seedList(["a@example.com", "b@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Q3 update", body: "## Hello\n\n![chart](https://cdn.example.com/chart.png)" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.recipientCount).toBe(2);
    expect(res.body.failures).toEqual([]);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    const calls = (sendEmail as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.to)).toEqual(["a@example.com", "b@example.com"]);
    for (const call of calls) {
      expect(call.from).toBe("kevin@distribute.you");
      // A broadcast is a fan-out to many people, not an email to a customer:
      // no standing blind copy, or one send would be multiplied by the list size
      expect(call.bcc).toBeUndefined();
      expect(call.subject).toBe("Q3 update");
      expect(call.htmlBody).toContain("Hello</h2>");
      expect(call.htmlBody).toContain('<img src="https://cdn.example.com/chart.png"');
      // Styling is inlined on the elements — a <style> block would be stripped.
      expect(call.htmlBody).toContain("max-width:600px");
      expect(call.htmlBody).not.toMatch(/<style\b/i);
      // No other recipient anywhere in the payload.
      const other = call.to === "a@example.com" ? "b@example.com" : "a@example.com";
      expect(JSON.stringify(call)).not.toContain(other);
    }
  });

  it("sends from the address the caller states, for that send only", async () => {
    seedList(["a@example.com", "b@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Flash vs Pro", body: "hello", from: "news@news.distribute.you" });

    expect(res.status).toBe(200);
    expect(res.body.from).toBe("news@news.distribute.you");

    const calls = (sendEmail as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.from)).toEqual([
      "news@news.distribute.you",
      "news@news.distribute.you",
    ]);
    expect(store.inserted.updates[0].fromAddress).toBe("news@news.distribute.you");
  });

  it("sends from the investor-update address when the caller states none", async () => {
    seedList(["a@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", body: "b" });

    expect(res.status).toBe(200);
    expect(res.body.from).toBe("kevin@distribute.you");
    expect((sendEmail as any).mock.calls[0][0].from).toBe("kevin@distribute.you");
    expect(store.inserted.updates[0].fromAddress).toBe("kevin@distribute.you");
  });

  it("refuses a sender that is not an address at all, before anything is sent", async () => {
    seedList(["a@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", body: "b", from: "news.distribute.you" });

    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(store.inserted.updates).toEqual([]);
  });

  it("fails the whole send with the provider's reason when the sender is unverified, and never retries the default", async () => {
    seedList(["a@example.com", "b@example.com"]);
    (sendEmail as any).mockRejectedValue(
      new Error(
        'Email sending failed (422): {"ErrorCode":400,"Message":"Sender signature not confirmed: news@news.distribute.you"}'
      )
    );

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Flash vs Pro", body: "b", from: "news@news.distribute.you" });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Sender signature not confirmed");
    expect(res.body.status).toBe("failed");
    expect(res.body.recipientCount).toBe(0);
    expect(res.body.from).toBe("news@news.distribute.you");

    // Every attempt used the stated sender; none fell back to the default.
    const attempted = (sendEmail as any).mock.calls.map((c: any[]) => c[0].from);
    expect(attempted.every((f: string) => f === "news@news.distribute.you")).toBe(true);
    expect(attempted).not.toContain("kevin@distribute.you");

    expect(store.inserted.updates[0].status).toBe("failed");
    expect(store.inserted.updates[0].fromAddress).toBe("news@news.distribute.you");
    expect(updateRun).toHaveBeenCalledWith("run-broadcast-1", "failed", expect.anything(), expect.anything());
  });

  it("stops after the first wave when nothing in it lands, rather than collecting the same refusal per member", async () => {
    seedList(Array.from({ length: 20 }, (_, i) => `m${i}@example.com`));
    (sendEmail as any).mockRejectedValue(new Error("Email sending failed (422): Sender signature not confirmed"));

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", body: "b", from: "news@news.distribute.you" });

    expect(res.status).toBe(502);
    // SEND_CONCURRENCY is 8: one wave attempted, the other 12 members untouched.
    expect(sendEmail).toHaveBeenCalledTimes(8);
    expect(res.body.failures).toHaveLength(8);
  });

  it("does not add its own unsubscribe markup — email-gateway appends the provider one", async () => {
    seedList(["a@example.com"]);

    await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", body: "hello" });

    const call = (sendEmail as any).mock.calls[0][0];
    expect(call.htmlBody).not.toContain("pm:unsubscribe");
    expect(call.htmlBody).not.toMatch(/unsubscribe/i);
  });

  it("skips members the provider is suppressing", async () => {
    seedList(["a@example.com", "gone@example.com"]);
    (fetchSuppressed as any).mockResolvedValue({
      isSuppressed: (email: string) => email === "gone@example.com",
      reasonFor: (email: string) => (email === "gone@example.com" ? "ManualSuppression" : null),
    });

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", body: "b" });

    expect(res.status).toBe(200);
    expect(res.body.recipientCount).toBe(1);
    expect(res.body.skippedOptedOut).toEqual(["gone@example.com"]);
    expect((sendEmail as any).mock.calls.map((c: any[]) => c[0].to)).toEqual(["a@example.com"]);
  });

  it("re-checks the provider at send time rather than accepting a cached answer", async () => {
    seedList(["a@example.com"]);

    await request(app).post("/mailing-lists/investors/updates").set(AUTH).send({ subject: "s", body: "b" });

    const [, callerPath, emails, options] = (fetchSuppressed as any).mock.calls[0];
    expect(callerPath).toBe("/mailing-lists/:slug/updates");
    expect(emails).toEqual(["a@example.com"]);
    expect(options).toEqual({ maxAgeMs: 0 });
  });

  it("reports a partial failure with the failing address and reason, and does not record a clean success", async () => {
    seedList(["ok@example.com", "bad@example.com"]);
    (sendEmail as any).mockImplementation(async ({ to }: { to: string }) => {
      if (to === "bad@example.com") throw new Error("Email sending failed (422): inactive recipient");
    });

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", body: "b" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("partial");
    expect(res.body.recipientCount).toBe(1);
    expect(res.body.failures).toEqual([
      { email: "bad@example.com", reason: "Email sending failed (422): inactive recipient" },
    ]);

    expect(store.inserted.updates[0].status).toBe("partial");
    expect(store.inserted.updates[0].recipientCount).toBe(1);
    expect(updateRun).toHaveBeenCalledWith("run-broadcast-1", "failed", expect.anything(), expect.anything());
  });

  it("records the body exactly as sent", async () => {
    seedList(["a@example.com"]);

    await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Q3", body: "**bold**" });

    const written = store.inserted.updates[0];
    const sent = (sendEmail as any).mock.calls[0][0];
    expect(written.htmlBody).toBe(sent.htmlBody);
    expect(written.bodyMarkdown).toBe("**bold**");
  });

  it("refuses to send to an empty list", async () => {
    seedList([]);
    const res = await request(app).post("/mailing-lists/investors/updates").set(AUTH).send({ subject: "s", body: "b" });
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses to send when every subscriber is opted out", async () => {
    seedList(["gone@example.com"]);
    (fetchSuppressed as any).mockResolvedValue({ isSuppressed: () => true, reasonFor: () => "HardBounce" });

    const res = await request(app).post("/mailing-lists/investors/updates").set(AUTH).send({ subject: "s", body: "b" });

    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("404s for a list that does not exist", async () => {
    const res = await request(app).post("/mailing-lists/investors/updates").set(AUTH).send({ subject: "s", body: "b" });
    expect(res.status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses a body carrying an SVG no mail client renders, naming the URL", async () => {
    seedList(["a@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Q3", body: "![Logo](https://distribute.you/brand/icon.svg)" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("https://distribute.you/brand/icon.svg");
    expect(res.body.error).toMatch(/svg/i);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(store.inserted.updates).toEqual([]);
  });

  it("refuses an SVG pasted as a raw <img> tag too", async () => {
    seedList(["a@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Q3", body: '<img src="https://cdn.example.com/chart.svg" alt="Chart">' });

    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends a PNG through untouched", async () => {
    seedList(["a@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Q3", body: "![Logo](https://distribute.you/brand/icon.png)" });

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("sends to a few thousand members in bounded waves", async () => {
    seedList(Array.from({ length: 2500 }, (_, i) => `member${i}@example.com`));

    const res = await request(app).post("/mailing-lists/investors/updates").set(AUTH).send({ subject: "s", body: "b" });

    expect(res.status).toBe(200);
    expect(res.body.recipientCount).toBe(2500);
    expect(sendEmail).toHaveBeenCalledTimes(2500);
  });
});

describe("GET /mailing-lists/:slug/updates", () => {
  it("returns subject, body as sent, timestamp and recipient count", async () => {
    store.list = { id: "list-1", slug: "investors" };
    store.updates = [
      {
        id: "update-1",
        subject: "Q3 update",
        bodyMarkdown: "**bold**",
        htmlBody: "<p><strong>bold</strong></p>",
        status: "sent",
        recipientCount: 12,
        failures: [],
        sentAt: new Date("2026-02-01T09:00:00Z"),
      },
    ];

    const res = await request(app).get("/mailing-lists/investors/updates").set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.updates[0]).toEqual({
      id: "update-1",
      subject: "Q3 update",
      body: "**bold**",
      htmlBody: "<p><strong>bold</strong></p>",
      status: "sent",
      recipientCount: 12,
      failures: [],
      sentAt: "2026-02-01T09:00:00.000Z",
    });
  });

  it("404s for a list that does not exist", async () => {
    const res = await request(app).get("/mailing-lists/investors/updates").set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe("POST /mailing-lists/updates/preview", () => {
  const BODY = "## Where we are\n\nWe **shipped**.\n\n| metric | value |\n| --- | --- |\n| ARR | 1 |";

  it("returns the identical HTML a real send of the same body produces", async () => {
    // The whole point of the endpoint. If these two ever diverge, an author is
    // approving one thing and investors are receiving another — which is what
    // happened while the admin console rendered its own preview.
    const preview = await request(app).post("/mailing-lists/updates/preview").set(AUTH).send({ body: BODY });

    seedList(["a@example.com"]);
    const sent = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Q3", body: BODY });

    expect(preview.status).toBe(200);
    expect(sent.status).toBe(200);
    expect(preview.body.htmlBody).toBe(store.inserted.updates[0].htmlBody);
  });

  it("sends nothing, records nothing, and reads no suppression list", async () => {
    seedList(["a@example.com"]);
    const res = await request(app).post("/mailing-lists/updates/preview").set(AUTH).send({ body: BODY });

    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(fetchSuppressed).not.toHaveBeenCalled();
    expect(store.inserted.updates).toHaveLength(0);
  });

  it("carries the plain-text part, which is the markdown itself", async () => {
    const res = await request(app).post("/mailing-lists/updates/preview").set(AUTH).send({ body: BODY });
    expect(res.body.textBody).toBe(BODY);
  });

  it("reports an image no client renders instead of refusing — a preview shows what you have", async () => {
    const res = await request(app)
      .post("/mailing-lists/updates/preview")
      .set(AUTH)
      .send({ body: "![logo](https://distribute.you/logo.svg)" });

    expect(res.status).toBe(200);
    expect(res.body.unrenderableImages).toEqual(["https://distribute.you/logo.svg"]);
    // Still rendered: the author needs to see the rest of the update.
    expect(res.body.htmlBody).toContain("logo.svg");
  });

  it("says nothing is wrong with a body whose images are all fine", async () => {
    const res = await request(app)
      .post("/mailing-lists/updates/preview")
      .set(AUTH)
      .send({ body: "![chart](https://distribute.you/chart.png)" });
    expect(res.body.unrenderableImages).toEqual([]);
  });

  it("needs no acting staff user — it resolves no provider key, sends nothing and spends nothing", async () => {
    const res = await request(app)
      .post("/mailing-lists/updates/preview")
      .set({ "X-API-Key": "test-service-key", "x-org-id": "org_456" })
      .send({ body: BODY });
    expect(res.status).toBe(200);
  });

  it("still requires the API key and an organisation", async () => {
    const noKey = await request(app)
      .post("/mailing-lists/updates/preview")
      .set("x-org-id", "org_456")
      .send({ body: BODY });
    expect(noKey.status).toBe(401);

    const noOrg = await request(app)
      .post("/mailing-lists/updates/preview")
      .set("X-API-Key", "test-service-key")
      .send({ body: BODY });
    expect(noOrg.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const res = await request(app).post("/mailing-lists/updates/preview").set(AUTH).send({ body: "" });
    expect(res.status).toBe(400);
  });
});

describe("an update whose body staff authored as HTML", () => {
  const AUTHORED =
    '<table role="presentation" width="600" style="width:100%;max-width:600px;">' +
    '<tr><td style="padding:36px 28px;font-size:16px;"><h1 style="font-size:26px;">Flash vs Pro</h1>' +
    '<p style="margin:0;">We measured <a href="https://distribute.you/bench">both</a>.</p>' +
    '<img src="https://cdn.distribute.you/latency.png" width="544" alt="latency" /></td></tr></table>';

  it("reaches every recipient byte-for-byte as authored", async () => {
    seedList(["ada@example.com", "bob@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Flash vs Pro", htmlBody: AUTHORED });

    expect(res.status).toBe(200);
    expect(res.body.recipientCount).toBe(2);
    const bodies = vi.mocked(sendEmail).mock.calls.map((c: any) => c[0].htmlBody);
    expect(bodies).toEqual([AUTHORED, AUTHORED]);
    // Not wrapped in the markdown shell, not re-rendered, nothing appended here.
    expect(bodies[0]).not.toContain("background-color:#f4f5f7");
  });

  it("carries a text part derived from the HTML when none is supplied", async () => {
    seedList(["ada@example.com"]);

    await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Flash vs Pro", htmlBody: AUTHORED });

    const call = vi.mocked(sendEmail).mock.calls[0][0] as any;
    expect(call.textBody).toContain("Flash vs Pro");
    expect(call.textBody).toContain("https://distribute.you/bench");
    expect(call.textBody).not.toContain("<");
  });

  it("sends the author's own text part when they wrote one", async () => {
    seedList(["ada@example.com"]);

    await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Flash vs Pro", htmlBody: AUTHORED, textBody: "Flash beats Pro. Read distribute.you/bench" });

    const call = vi.mocked(sendEmail).mock.calls[0][0] as any;
    expect(call.textBody).toBe("Flash beats Pro. Read distribute.you/bench");
  });

  it("refuses a document no text part can be derived from rather than sending without one", async () => {
    seedList(["ada@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", htmlBody: '<table><tr><td><img src="https://cdn.test/all.png"></td></tr></table>' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("textBody");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("still goes one message per recipient, skipping the suppressed", async () => {
    seedList(["ada@example.com", "gone@example.com"]);
    vi.mocked(fetchSuppressed).mockResolvedValue({
      isSuppressed: (email: string) => email === "gone@example.com",
      reasonFor: () => "HardBounce",
    } as any);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", htmlBody: AUTHORED });

    expect(res.body.skippedOptedOut).toEqual(["gone@example.com"]);
    expect(vi.mocked(sendEmail).mock.calls.map((c: any) => c[0].to)).toEqual(["ada@example.com"]);
  });

  it("takes the sender stated per send, exactly as a markdown update does", async () => {
    seedList(["ada@example.com"]);

    await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", htmlBody: AUTHORED, from: "news@news.distribute.you" });

    expect((vi.mocked(sendEmail).mock.calls[0][0] as any).from).toBe("news@news.distribute.you");
    expect(store.inserted.updates[0].fromAddress).toBe("news@news.distribute.you");
  });

  it("records what kind of body it was, and no markdown it never had", async () => {
    seedList(["ada@example.com"]);

    await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", htmlBody: AUTHORED });

    expect(store.inserted.updates[0].bodyKind).toBe("html");
    expect(store.inserted.updates[0].bodyMarkdown).toBeNull();
    expect(store.inserted.updates[0].htmlBody).toBe(AUTHORED);
  });

  it("refuses an SVG the same way — a broken placeholder is broken whoever wrote the markup", async () => {
    seedList(["ada@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", htmlBody: '<p>hi</p><img src="https://cdn.test/logo.svg" alt="logo">' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("logo.svg");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses both bodies at once, and neither, rather than choosing", async () => {
    seedList(["ada@example.com"]);

    const both = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", body: "# md", htmlBody: AUTHORED });
    expect(both.status).toBe(400);

    const neither = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s" });
    expect(neither.status).toBe(400);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses a text part offered beside markdown, which would be dropped silently", async () => {
    seedList(["ada@example.com"]);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", body: "# md", textBody: "plain" });

    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("records a markdown update exactly as before", async () => {
    seedList(["ada@example.com"]);

    await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Q3", body: "## Hi" });

    expect(store.inserted.updates[0].bodyKind).toBe("markdown");
    expect(store.inserted.updates[0].bodyMarkdown).toBe("## Hi");
    expect(store.inserted.updates[0].htmlBody).toContain("max-width:600px");
    expect((vi.mocked(sendEmail).mock.calls[0][0] as any).textBody).toBe("## Hi");
  });
});

describe("previewing an authored HTML body", () => {
  const AUTHORED = '<table><tr><td><h1>Flash vs Pro</h1><p>We measured both.</p></td></tr></table>';

  it("returns it unchanged, which is what a send does with it", async () => {
    const res = await request(app).post("/mailing-lists/updates/preview").set(AUTH).send({ htmlBody: AUTHORED });

    expect(res.status).toBe(200);
    expect(res.body.htmlBody).toBe(AUTHORED);
    expect(res.body.bodyKind).toBe("html");
    expect(res.body.textBody).toBe("Flash vs Pro\n\nWe measured both.");
    expect(res.body.unrenderableImages).toEqual([]);
  });

  it("previews the same bytes a send of the same body puts on the wire", async () => {
    const preview = await request(app).post("/mailing-lists/updates/preview").set(AUTH).send({ htmlBody: AUTHORED });

    seedList(["ada@example.com"]);
    await request(app).post("/mailing-lists/investors/updates").set(AUTH).send({ subject: "s", htmlBody: AUTHORED });

    const sentCall = vi.mocked(sendEmail).mock.calls[0][0] as any;
    expect(preview.body.htmlBody).toBe(sentCall.htmlBody);
    expect(preview.body.textBody).toBe(sentCall.textBody);
  });

  it("says a markdown preview is markdown", async () => {
    const res = await request(app).post("/mailing-lists/updates/preview").set(AUTH).send({ body: "## Hi" });
    expect(res.body.bodyKind).toBe("markdown");
    expect(res.body.textBody).toBe("## Hi");
  });

  it("reports an SVG in an authored body without refusing it", async () => {
    const res = await request(app)
      .post("/mailing-lists/updates/preview")
      .set(AUTH)
      .send({ htmlBody: '<p>hi</p><img src="https://cdn.test/logo.svg">' });

    expect(res.status).toBe(200);
    expect(res.body.unrenderableImages).toEqual(["https://cdn.test/logo.svg"]);
  });

  it("refuses both bodies at once, and neither", async () => {
    const both = await request(app)
      .post("/mailing-lists/updates/preview")
      .set(AUTH)
      .send({ body: "# md", htmlBody: AUTHORED });
    expect(both.status).toBe(400);

    const neither = await request(app).post("/mailing-lists/updates/preview").set(AUTH).send({});
    expect(neither.status).toBe(400);
  });
});
