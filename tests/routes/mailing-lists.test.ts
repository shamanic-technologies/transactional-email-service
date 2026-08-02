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
