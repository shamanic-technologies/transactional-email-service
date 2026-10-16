import request from "supertest";
import { vi, beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";

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
import { emailEvents } from "../../src/db/schema.js";
import { sendOrglessPlatformEmail } from "../../src/lib/email-gateway.js";
import { seedStaffTemplates } from "../../src/templates/staff-alerts.js";
import { ADMIN_EMAILS } from "../../src/lib/staff-recipients.js";

const API_KEY = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY!;

const BODY = {
  eventType: "sending_domain_blocklisted",
  eventId: "boostdistribute.com:SURBL:2026-10-16",
  metadata: {
    domain: "boostdistribute.com",
    listName: "SURBL",
    listedSince: "2026-10-16",
    listAnswer: "ABUSE",
    mailboxesAffected: "ruth@boostdistribute.com, kevin@boostdistribute.com",
    actionTaken: "The 2 mailboxes no longer start new sequences.",
    removalUrl: "https://www.surbl.org/surbl-analysis",
  },
};

function post(body: unknown) {
  return request(app).post("/platform-staff-alert").set("X-API-Key", API_KEY).send(body as object);
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
  await seedStaffTemplates();
}, 15000);

beforeEach(async () => {
  await sql`TRUNCATE TABLE email_events CASCADE`;
  vi.mocked(sendOrglessPlatformEmail).mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await sql.end();
});

describe("POST /platform-staff-alert (database-backed)", () => {
  it("delivers once per event id; the repeat answers duplicate and sends nothing", async () => {
    const first = await post(BODY);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ sent: true, duplicate: false, eventId: BODY.eventId });

    const second = await post(BODY);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ sent: false, duplicate: true, eventId: BODY.eventId, runId: null });

    expect(sendOrglessPlatformEmail).toHaveBeenCalledTimes(ADMIN_EMAILS.length);
    const rows = await db.select().from(emailEvents).where(eq(emailEvents.eventType, "sending_domain_blocklisted"));
    expect(rows).toHaveLength(ADMIN_EMAILS.length);
    expect(rows[0]).toMatchObject({ status: "sent", orgId: null, userId: null, recipientEmail: ADMIN_EMAILS[0] });
  });

  it("a failed delivery is retried by the same event id and sends exactly once", async () => {
    vi.mocked(sendOrglessPlatformEmail).mockRejectedValueOnce(new Error("Email sending failed (500)"));
    const failed = await post(BODY);
    expect(failed.status).toBe(502);
    let [row] = await db.select().from(emailEvents).where(eq(emailEvents.eventType, "sending_domain_blocklisted"));
    expect(row.status).toBe("failed");

    const retry = await post(BODY);
    expect(retry.status).toBe(200);
    expect(retry.body.sent).toBe(true);

    const again = await post(BODY);
    expect(again.body.duplicate).toBe(true);

    expect(sendOrglessPlatformEmail).toHaveBeenCalledTimes(2);
    const rows = await db.select().from(emailEvents).where(eq(emailEvents.eventType, "sending_domain_blocklisted"));
    expect(rows).toHaveLength(1);
    [row] = rows;
    expect(row.status).toBe("sent");
    expect(row.errorMessage).toBeNull();
  });

  it("a different event id is a new alert", async () => {
    await post(BODY);
    const other = await post({ ...BODY, eventId: "boostdistribute.com:Spamhaus DBL:2026-10-16" });
    expect(other.body.sent).toBe(true);
    expect(sendOrglessPlatformEmail).toHaveBeenCalledTimes(2 * ADMIN_EMAILS.length);
  });
});
