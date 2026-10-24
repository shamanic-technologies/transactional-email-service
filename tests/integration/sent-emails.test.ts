import request from "supertest";
import { vi, beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// TX-EMAIL-IN-UNIBOX-1024: every transactional email sent to a client is served
// for its Unibox thread, exactly once; a failed send never is.

vi.mock("../../src/lib/client-service.js", () => ({
  resolveUserEmail: vi.fn().mockResolvedValue("user@test.com"),
}));

vi.mock("../../src/lib/email-gateway.js", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendOrglessPlatformEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-456" }),
  updateRun: vi.fn().mockResolvedValue({}),
  createPlatformRun: vi.fn().mockResolvedValue({ id: "platform-run-1" }),
  updatePlatformRun: vi.fn().mockResolvedValue({}),
}));

import app from "../../src/index.js";
import { db, sql } from "../../src/db/index.js";
import { emailEvents, emailTemplates } from "../../src/db/schema.js";
import { sendEmail } from "../../src/lib/email-gateway.js";

const API_KEY = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY!;
const ORG = "06ffd332-b05d-4468-bc33-fe2789caad95";
const HEADERS = { "x-org-id": ORG, "x-user-id": "user_test", "x-run-id": "run_test" };

// One template per kind of client email; every one goes through the same path.
const CLIENT_TEMPLATES = [
  { name: "credit-depleted", subject: "Your credit ran out, {{name}}", htmlBody: "<p>Top up {{name}}</p>", textBody: "Top up {{name}}" },
  { name: "credit-depleted-followup-3d", subject: "Still out of credit", htmlBody: "<p>3 days</p>", textBody: "3 days" },
  { name: "credits-reload-failed", subject: "Card refused", htmlBody: "<p>Card refused</p>", textBody: "Card refused" },
  { name: "welcome", subject: "Welcome", htmlBody: "<p>Welcome</p>", textBody: "Welcome" },
  { name: "campaign_created", subject: "Campaign: {{campaignName}}", htmlBody: "<p>Campaign</p>", textBody: "Campaign" },
];

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
  for (const tpl of [
    ...CLIENT_TEMPLATES,
    { name: "brand_daily_budget_changed", subject: "Budget changed", htmlBody: "<p>b</p>", textBody: "b" },
    { name: "agent_signup_code", subject: "Your code {{code}}", htmlBody: "<p>{{code}}</p>", textBody: "{{code}}" },
  ]) {
    await db.insert(emailTemplates).values(tpl).onConflictDoNothing();
  }
}, 15000);

beforeEach(async () => {
  await sql`TRUNCATE TABLE email_events CASCADE`;
  vi.mocked(sendEmail).mockClear();
});

afterAll(async () => {
  await sql`TRUNCATE TABLE email_events CASCADE`;
  await sql.end();
});

async function feed(query: Record<string, string> = {}) {
  const res = await request(app).get("/internal/sent-emails").query(query).set("x-api-key", API_KEY);
  expect(res.status).toBe(200);
  return res.body as { emails: Array<Record<string, any>>; nextCursor: string | null };
}

describe("GET /internal/sent-emails", () => {
  it("requires the API key", async () => {
    const res = await request(app).get("/internal/sent-emails");
    expect(res.status).toBe(401);
  });

  it("serves exactly one message per template sent, as it went on the wire", async () => {
    for (const tpl of CLIENT_TEMPLATES) {
      const res = await request(app)
        .post("/send")
        .set("x-api-key", API_KEY)
        .set(HEADERS)
        .send({ eventType: tpl.name, recipientEmail: "client@test.com", brandIds: ["brand_test"], metadata: { name: "Ada", campaignName: "Q4" } });
      expect(res.body.results[0].sent).toBe(true);
    }

    const { emails } = await feed();
    expect(emails.map((e) => e.eventType).sort()).toEqual(CLIENT_TEMPLATES.map((t) => t.name).sort());
    for (const email of emails) {
      const wire = vi.mocked(sendEmail).mock.calls.find(([arg]) => arg.tag === email.eventType)![0];
      expect(email).toMatchObject({
        recipientEmail: "client@test.com",
        orgId: ORG,
        brandIds: ["brand_test"],
        subject: wire.subject,
        htmlBody: wire.htmlBody,
        textBody: wire.textBody,
        messageSource: "stored",
      });
      expect(typeof email.sentAt).toBe("string");
    }
    expect(emails.find((e) => e.eventType === "credit-depleted")!.subject).toBe("Your credit ran out, Ada");
  });

  it("serves nothing for a failed send", async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("email sending down"));
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .set(HEADERS)
      .send({ eventType: "credit-depleted", recipientEmail: "client@test.com", metadata: { name: "Ada" } });
    expect(res.body.results[0].sent).toBe(false);

    const { emails, nextCursor } = await feed();
    expect(emails).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  it("never serves a staff-routed alert", async () => {
    await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .set(HEADERS)
      .send({ eventType: "brand_daily_budget_changed", metadata: { email: "client@test.com" } });
    const rows = await db.select().from(emailEvents);
    expect(rows.some((r) => r.status === "sent")).toBe(true);

    expect((await feed()).emails).toEqual([]);
  });

  it("serves an org-less send (a person with no account yet) the same way", async () => {
    const res = await request(app)
      .post("/platform-orgless-send")
      .set("x-api-key", API_KEY)
      .send({ eventType: "agent_signup_code", recipientEmail: "new@test.com", metadata: { code: "123456", expiresInMinutes: "15" } });
    expect(res.status).toBe(200);

    const { emails } = await feed();
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ recipientEmail: "new@test.com", orgId: null, messageSource: "stored" });
    expect(emails[0].subject).toBe("Your code 123456");
  });

  it("pages oldest first and an empty page hands the cursor back", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/send")
        .set("x-api-key", API_KEY)
        .set(HEADERS)
        .send({ eventType: "campaign_created", recipientEmail: `c${i}@test.com`, metadata: { campaignName: `n${i}` } });
    }
    const first = await feed({ limit: "2" });
    expect(first.emails.map((e) => e.recipientEmail)).toEqual(["c0@test.com", "c1@test.com"]);
    const second = await feed({ limit: "2", after: first.nextCursor! });
    expect(second.emails.map((e) => e.recipientEmail)).toEqual(["c2@test.com"]);
    const third = await feed({ limit: "2", after: second.nextCursor! });
    expect(third.emails).toEqual([]);
    expect(third.nextCursor).toBe(second.nextCursor);
  });

  it("replays a send made before messages were stored, and labels a lost template", async () => {
    await db.insert(emailEvents).values([
      { eventType: "credit-depleted", recipientEmail: "old@test.com", orgId: "org_test", status: "sent", metadata: { name: "Bo" }, sentAt: new Date("2026-03-01T10:00:00Z") },
      { eventType: "template-long-gone", recipientEmail: "old@test.com", orgId: "org_test", status: "sent", metadata: {}, sentAt: new Date("2026-03-02T10:00:00Z") },
    ]);

    const { emails } = await feed();
    expect(emails).toHaveLength(2);
    expect(emails[0]).toMatchObject({ eventType: "credit-depleted", subject: "Your credit ran out, Bo", messageSource: "replayed", sentAt: "2026-03-01T10:00:00.000Z" });
    expect(emails[1]).toMatchObject({ eventType: "template-long-gone", subject: null, htmlBody: null, messageSource: "unavailable" });
  });

  it("serves no org for a row that predates internal org ids", async () => {
    await db.insert(emailEvents).values([
      { eventType: "welcome", recipientEmail: "feb@test.com", orgId: "legacy", status: "sent", sentAt: new Date("2026-02-16T10:00:00Z") },
      { eventType: "welcome", recipientEmail: "feb@test.com", orgId: "org_38y0ZSEtw1lz0KtH9Kwy53jBu67", status: "sent", sentAt: new Date("2026-02-17T10:00:00Z") },
      { eventType: "welcome", recipientEmail: "now@test.com", orgId: "06ffd332-b05d-4468-bc33-fe2789caad95", status: "sent", sentAt: new Date("2026-10-24T10:00:00Z") },
    ]);

    const { emails } = await feed();
    expect(emails.map((e) => e.orgId)).toEqual([null, null, "06ffd332-b05d-4468-bc33-fe2789caad95"]);
  });

  it("refuses a cursor it never issued", async () => {
    const res = await request(app).get("/internal/sent-emails").query({ after: "garbage" }).set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
  });
});
