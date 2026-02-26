import request from "supertest";
import { vi, beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";

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

import app from "../../src/index.js";
import { db, sql } from "../../src/db/index.js";
import { emailEvents } from "../../src/db/schema.js";
import { sendEmail } from "../../src/lib/email-gateway.js";
import { resolveUserEmail } from "../../src/lib/client-service.js";

const API_KEY = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY!;

// Base fields required by every request
const BASE = { brandId: "brand_test", campaignId: "campaign_test" };

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
}, 15000);

beforeEach(async () => {
  await sql`TRUNCATE TABLE email_events CASCADE`;
  vi.mocked(sendEmail).mockClear();
  vi.mocked(resolveUserEmail).mockClear();
});

afterAll(async () => {
  await sql`TRUNCATE TABLE email_events CASCADE`;
  await sql.end();
});

// --- Auth ---

describe("authentication", () => {
  it("rejects request without API key", async () => {
    const res = await request(app)
      .post("/send")
      .send({ appId: "mcpfactory", eventType: "waitlist", ...BASE, recipientEmail: "a@b.com" });
    expect(res.status).toBe(401);
  });

  it("rejects request with wrong API key", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", "wrong-key")
      .send({ appId: "mcpfactory", eventType: "waitlist", ...BASE, recipientEmail: "a@b.com" });
    expect(res.status).toBe(401);
  });
});

// --- Validation ---

describe("validation", () => {
  it("rejects missing appId", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ eventType: "waitlist", ...BASE, recipientEmail: "a@b.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(res.body.details.fieldErrors).toHaveProperty("appId");
  });

  it("rejects missing eventType", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ appId: "mcpfactory", ...BASE, recipientEmail: "a@b.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(res.body.details.fieldErrors).toHaveProperty("eventType");
  });

  it("succeeds without brandId or campaignId", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ appId: "mcpfactory", eventType: "waitlist", recipientEmail: "a@b.com" });
    expect(res.status).toBe(200);
  });

  it("rejects request with no recipient info", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ appId: "mcpfactory", eventType: "waitlist", ...BASE });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/userId|recipientEmail/);
  });
});

// --- Once-only dedup ---

describe("once-only dedup", () => {
  it("sends waitlist email on first request", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ appId: "mcpfactory", eventType: "waitlist", ...BASE, recipientEmail: "new@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(true);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
  });

  it("blocks duplicate waitlist for same email", async () => {
    const payload = { appId: "mcpfactory", eventType: "waitlist", ...BASE, recipientEmail: "dup@example.com" };

    await request(app).post("/send").set("x-api-key", API_KEY).send(payload);
    const res = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);

    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(false);
    expect(res.body.results[0].reason).toBe("duplicate");
  });

  it("sends welcome email via userId and blocks duplicate", async () => {
    const payload = { appId: "mcpfactory", eventType: "welcome", ...BASE, userId: "user_123" };

    const first = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);
    expect(first.body.results[0].sent).toBe(true);

    const second = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);
    expect(second.body.results[0].sent).toBe(false);
    expect(second.body.results[0].reason).toBe("duplicate");
  });
});

// --- Daily dedup ---

describe("daily dedup", () => {
  it("sends user_active on first request", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ appId: "mcpfactory", eventType: "user_active", ...BASE, userId: "user_456" });
    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(true);
  });

  it("blocks duplicate user_active for same user on same day", async () => {
    const payload = { appId: "mcpfactory", eventType: "user_active", ...BASE, userId: "user_789" };

    await request(app).post("/send").set("x-api-key", API_KEY).send(payload);
    const res = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);

    expect(res.body.results[0].sent).toBe(false);
    expect(res.body.results[0].reason).toBe("duplicate");
  });
});

// --- Product-scoped dedup ---

describe("product-scoped dedup", () => {
  it("sends webinar_welcome with productId on first request", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({
        appId: "generic",
        eventType: "webinar_welcome",
        recipientEmail: "marie@test.com",
        productId: "webinar-2026-02-28",
        metadata: { productName: "Launch Webinar" },
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(true);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
  });

  it("blocks duplicate webinar_welcome for same user + product", async () => {
    const payload = {
      appId: "generic",
      eventType: "webinar_welcome",
      recipientEmail: "marie@test.com",
      productId: "webinar-2026-03-01",
      metadata: { productName: "Launch Webinar" },
    };

    await request(app).post("/send").set("x-api-key", API_KEY).send(payload);
    const res = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);

    expect(res.body.results[0].sent).toBe(false);
    expect(res.body.results[0].reason).toBe("duplicate");
  });

  it("allows same user for different products", async () => {
    const base = {
      appId: "generic",
      eventType: "webinar_welcome",
      recipientEmail: "marie@test.com",
      metadata: { productName: "Webinar" },
    };

    const first = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ ...base, productId: "webinar-A" });
    const second = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ ...base, productId: "webinar-B" });

    expect(first.body.results[0].sent).toBe(true);
    expect(second.body.results[0].sent).toBe(true);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(2);
  });

  it("deduplicates j_minus_3 per user x product", async () => {
    const payload = {
      appId: "generic",
      eventType: "j_minus_3",
      recipientEmail: "bob@test.com",
      productId: "webinar-2026-03-15",
      metadata: { productName: "AI Workshop" },
    };

    const first = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);
    const second = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);

    expect(first.body.results[0].sent).toBe(true);
    expect(second.body.results[0].sent).toBe(false);
    expect(second.body.results[0].reason).toBe("duplicate");
  });
});

// --- Anonymous welcome dedup ---

describe("anonymous welcome dedup", () => {
  it("deduplicates welcome by recipientEmail when no userId", async () => {
    const payload = {
      appId: "mcpfactory",
      eventType: "welcome",
      recipientEmail: "anon@test.com",
    };

    const first = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);
    const second = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);

    expect(first.body.results[0].sent).toBe(true);
    expect(second.body.results[0].sent).toBe(false);
    expect(second.body.results[0].reason).toBe("duplicate");
  });

});

// --- Repeatable events ---

describe("repeatable events", () => {
  it("allows multiple sends for campaign_created", async () => {
    const payload = { appId: "mcpfactory", eventType: "campaign_created", ...BASE, recipientEmail: "user@test.com" };

    const first = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);
    const second = await request(app).post("/send").set("x-api-key", API_KEY).send(payload);

    expect(first.body.results[0].sent).toBe(true);
    expect(second.body.results[0].sent).toBe(true);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(2);
  });
});

// --- Recipient resolution ---

describe("recipient resolution", () => {
  it("uses recipientEmail directly", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ appId: "mcpfactory", eventType: "campaign_created", ...BASE, recipientEmail: "direct@test.com" });
    expect(res.body.results[0].email).toBe("direct@test.com");
    expect(res.body.results[0].sent).toBe(true);
  });

  it("resolves email via client-service when userId provided", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ appId: "mcpfactory", eventType: "campaign_created", ...BASE, userId: "user_abc" });
    expect(vi.mocked(resolveUserEmail)).toHaveBeenCalledWith("user_abc");
    expect(res.body.results[0].email).toBe("user@test.com");
    expect(res.body.results[0].sent).toBe(true);
  });

  it("sends admin notifications to admin email", async () => {
    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ appId: "mcpfactory", eventType: "signup_notification", ...BASE, userId: "user_new" });
    expect(res.body.results[0].email).toBe("kevin@mcpfactory.org");
    expect(res.body.results[0].sent).toBe(true);
  });
});

// --- DB state ---

describe("database records", () => {
  it("inserts email_event row with correct fields", async () => {
    await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ appId: "mcpfactory", eventType: "campaign_created", ...BASE, recipientEmail: "db@test.com", metadata: { foo: "bar" } });

    const rows = await db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.recipientEmail, "db@test.com"));

    expect(rows).toHaveLength(1);
    expect(rows[0].appId).toBe("mcpfactory");
    expect(rows[0].eventType).toBe("campaign_created");
    expect(rows[0].status).toBe("sent");
    expect(rows[0].metadata).toEqual({ foo: "bar" });
  });

  it("records failed status when email sending throws", async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("email sending down"));

    const res = await request(app)
      .post("/send")
      .set("x-api-key", API_KEY)
      .send({ appId: "mcpfactory", eventType: "waitlist", ...BASE, recipientEmail: "fail@test.com" });

    expect(res.body.results[0].sent).toBe(false);
    expect(res.body.results[0].reason).toBe("email sending down");

    const rows = await db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.recipientEmail, "fail@test.com"));

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toBe("email sending down");
  });
});
