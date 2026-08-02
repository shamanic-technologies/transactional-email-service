import request from "supertest";
import { vi, beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// Mock external services before app imports
vi.mock("../../src/lib/client-service.js", () => ({
  resolveUserEmail: vi.fn().mockResolvedValue("user@test.com"),
}));

vi.mock("../../src/lib/email-gateway.js", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-456" }),
  updateRun: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/lib/suppression.js", () => ({
  fetchSuppressed: vi.fn().mockResolvedValue({ isSuppressed: () => false, reasonFor: () => null }),
}));

import app from "../../src/index.js";
import { db, sql } from "../../src/db/index.js";
import { sendEmail } from "../../src/lib/email-gateway.js";
import { fetchSuppressed } from "../../src/lib/suppression.js";

const API_KEY = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY!;
const AUTH = { "x-api-key": API_KEY, "x-org-id": "org_test", "x-user-id": "user_staff" };

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
}, 15000);

beforeEach(async () => {
  await sql`TRUNCATE TABLE mailing_lists CASCADE`;
  vi.mocked(sendEmail).mockClear();
  vi.mocked(sendEmail).mockResolvedValue(undefined);
  vi.mocked(fetchSuppressed).mockResolvedValue({ isSuppressed: () => false, reasonFor: () => null });
});

afterAll(async () => {
  await sql`TRUNCATE TABLE mailing_lists CASCADE`;
  await sql.end();
});

async function paste(raw: string) {
  return request(app).post("/mailing-lists/investors/subscribers").set(AUTH).send({ raw });
}

describe("mailing list lifecycle", () => {
  it("creates the list on first paste and adds the valid addresses", async () => {
    const res = await paste("Ada <ada@example.com>; bob@example.com,\nnot-an-email");

    expect(res.status).toBe(200);
    expect(res.body.added.sort()).toEqual(["ada@example.com", "bob@example.com"]);
    expect(res.body.rejected).toEqual([{ value: "not-an-email", reason: "not a valid email address" }]);

    const list = await request(app).get("/mailing-lists/investors/subscribers").set(AUTH);
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(2);
    expect(list.body.subscribers.map((s: any) => s.email).sort()).toEqual(["ada@example.com", "bob@example.com"]);
    expect(list.body.subscribers.every((s: any) => s.optedOut === false)).toBe(true);
  });

  it("re-pasting the same blob is a no-op", async () => {
    await paste("ada@example.com, bob@example.com");
    const second = await paste("ADA@example.com\nbob@example.com; carol@example.com");

    expect(second.body.added).toEqual(["carol@example.com"]);
    expect(second.body.skipped.sort()).toEqual(["ada@example.com", "bob@example.com"]);

    const list = await request(app).get("/mailing-lists/investors/subscribers").set(AUTH);
    expect(list.body.count).toBe(3);
  });

  it("removes an address", async () => {
    await paste("ada@example.com, bob@example.com");

    const removed = await request(app)
      .delete("/mailing-lists/investors/subscribers")
      .query({ email: "ada@example.com" })
      .set(AUTH);
    expect(removed.status).toBe(200);

    const list = await request(app).get("/mailing-lists/investors/subscribers").set(AUTH);
    expect(list.body.subscribers.map((s: any) => s.email)).toEqual(["bob@example.com"]);

    const again = await request(app)
      .delete("/mailing-lists/investors/subscribers")
      .query({ email: "ada@example.com" })
      .set(AUTH);
    expect(again.status).toBe(404);
  });

  it("shows a provider-suppressed member as opted out", async () => {
    await paste("ada@example.com, gone@example.com");
    vi.mocked(fetchSuppressed).mockResolvedValue({
      isSuppressed: (email: string) => email === "gone@example.com",
      reasonFor: (email: string) => (email === "gone@example.com" ? "ManualSuppression" : null),
    });

    const list = await request(app).get("/mailing-lists/investors/subscribers").set(AUTH);
    const gone = list.body.subscribers.find((s: any) => s.email === "gone@example.com");
    expect(gone.optedOut).toBe(true);
    expect(gone.optedOutReason).toBe("ManualSuppression");
  });
});

describe("sending and history", () => {
  it("sends one message per recipient and records the update", async () => {
    await paste("ada@example.com, bob@example.com");

    const sent = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Q3 update", body: "## Hi\n\n![chart](https://cdn.example.com/q3.png)" });

    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("sent");
    expect(sent.body.recipientCount).toBe(2);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(2);

    const history = await request(app).get("/mailing-lists/investors/updates").set(AUTH);
    expect(history.status).toBe(200);
    expect(history.body.count).toBe(1);
    expect(history.body.updates[0].subject).toBe("Q3 update");
    expect(history.body.updates[0].htmlBody).toContain("Hi</h2>");
    expect(history.body.updates[0].htmlBody).toContain("max-width:600px");
    expect(history.body.updates[0].recipientCount).toBe(2);
    expect(typeof history.body.updates[0].sentAt).toBe("string");
  });

  it("does not send to an opted-out member", async () => {
    await paste("ada@example.com, gone@example.com");
    vi.mocked(fetchSuppressed).mockResolvedValue({
      isSuppressed: (email: string) => email === "gone@example.com",
      reasonFor: (email: string) => (email === "gone@example.com" ? "ManualSuppression" : null),
    });

    const sent = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", body: "b" });

    expect(sent.body.recipientCount).toBe(1);
    expect(sent.body.skippedOptedOut).toEqual(["gone@example.com"]);
    expect(vi.mocked(sendEmail).mock.calls.map((c) => c[0].to)).toEqual(["ada@example.com"]);
  });

  it("records a partial send as partial, naming the failing address", async () => {
    await paste("ok@example.com, bad@example.com");
    vi.mocked(sendEmail).mockImplementation(async ({ to }: any) => {
      if (to === "bad@example.com") throw new Error("Email sending failed (422): inactive recipient");
    });

    const sent = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "s", body: "b" });

    expect(sent.body.status).toBe("partial");
    expect(sent.body.failures).toEqual([
      { email: "bad@example.com", reason: "Email sending failed (422): inactive recipient" },
    ]);

    const history = await request(app).get("/mailing-lists/investors/updates").set(AUTH);
    expect(history.body.updates[0].status).toBe("partial");
    expect(history.body.updates[0].recipientCount).toBe(1);
    expect(history.body.updates[0].failures).toHaveLength(1);
  });

  it("404s on an unknown list", async () => {
    const res = await request(app).get("/mailing-lists/nobody/updates").set(AUTH);
    expect(res.status).toBe(404);
  });
});
