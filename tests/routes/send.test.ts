import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockWhere,
  mockSet,
  mockUpdate,
  mockReturning,
  mockOnConflictDoNothing,
  mockValues,
  mockInsert,
  mockSelectLimit,
} = vi.hoisted(() => {
  process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "test-api-key";
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-service-key";

  const mockWhere = vi.fn().mockResolvedValue(undefined);
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

  const mockReturning = vi.fn().mockResolvedValue([{ id: "fake-id" }]);
  const mockOnConflictDoNothing = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockValues = vi.fn().mockReturnValue({
    onConflictDoNothing: mockOnConflictDoNothing,
    returning: mockReturning,
  });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

  // DB template lookup — returns a generic template by default (no hardcoded templates)
  const mockSelectLimit = vi.fn().mockResolvedValue([{
    name: "test",
    subject: "Test subject",
    htmlBody: "<p>Test</p>",
    textBody: "Test",
    fromAddress: null,
  }]);

  return { mockWhere, mockSet, mockUpdate, mockReturning, mockOnConflictDoNothing, mockValues, mockInsert, mockSelectLimit };
});

// Mock db to avoid needing a real database
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: mockInsert,
    update: mockUpdate,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: mockSelectLimit,
        }),
      }),
    }),
  },
}));

// Mock client-service to avoid external calls
vi.mock("../../src/lib/client-service.js", () => ({
  resolveUserEmail: vi.fn().mockResolvedValue("user@example.com"),
}));

// Mock runs-client to avoid external calls
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-456" }),
  updateRun: vi.fn().mockResolvedValue({}),
}));

// Mock trace-event to avoid external calls
vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import express from "express";
import sendRoutes from "../../src/routes/send.js";
import { createRun } from "../../src/lib/runs-client.js";

let fetchSpy: ReturnType<typeof vi.fn>;

const app = express();
app.use(express.json());
app.use(sendRoutes);

// Identity headers applied to all requests
const HEADERS = { "x-org-id": "org_456", "x-user-id": "user_123", "x-run-id": "run_caller_001" };

const DB_TEMPLATE_ROW = {
  name: "test",
  subject: "Test subject",
  htmlBody: "<p>Test</p>",
  textBody: "Test",
  fromAddress: null,
};

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchSpy);
  vi.clearAllMocks();
  // Restore default mock implementations after clearAllMocks
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockReturnValue({
    onConflictDoNothing: mockOnConflictDoNothing,
    returning: mockReturning,
  });
  mockOnConflictDoNothing.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([{ id: "fake-id" }]);
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockResolvedValue(undefined);
  mockSelectLimit.mockResolvedValue([DB_TEMPLATE_ROW]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /send", () => {
  it("creates a run and passes all required fields to email gateway", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "user_active",
        brandIds: ["brand_abc"],
        campaignId: "campaign_def",
      });

    expect(res.status).toBe(200);
    // Admin-notification events fan out to all admin recipients
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.type).toBe("transactional");
    expect(body.clerkOrgId).toBe("org_456");
    expect(body.runId).toBe("run-456");
    expect(body.to).toBeDefined();
    expect(body.subject).toBeDefined();
    expect(body.brandIds).toBeUndefined();
    expect(body.campaignId).toBe("campaign_def");
  });

  it("returns 400 when x-org-id header is missing", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set("x-user-id", "user_123")
      .set("x-run-id", "run_001")
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required headers");
  });

  it("returns 400 when x-user-id header is missing", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .set("x-run-id", "run_001")
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required headers");
  });

  it("returns 400 when x-run-id header is missing", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .set("x-user-id", "user_123")
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required headers");
  });

  it("returns 400 when eventType is missing", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(res.body.details.fieldErrors).toHaveProperty("eventType");
  });

  it("succeeds without brandIds/campaignId and omits them from request", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(200);
    // Admin-notification events fan out to all admin recipients
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.brandIds).toBeUndefined();
    expect(body.campaignId).toBeUndefined();
    // Hardcoded staff BCC is always appended, even with no caller bccEmails
    expect(body.bcc).toBe("kevin@distribute.you,kevin.lourd@gmail.com");
  });

  it("forwards bccEmails to the provider payload as bcc", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "primary@example.com",
        bccEmails: ["alpha1@example.com", "alpha2@example.com"],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "primary@example.com", sent: true }]);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.to).toBe("primary@example.com");
    // Caller bccEmails first, then hardcoded staff appended (never affects primary `to`)
    expect(body.bcc).toBe("alpha1@example.com,alpha2@example.com,kevin@distribute.you,kevin.lourd@gmail.com");
  });

  it("does not render bccEmails into primary-recipient content or metadata", async () => {
    mockSelectLimit.mockResolvedValueOnce([{
      name: "welcome",
      subject: "Welcome {{name}}",
      htmlBody: "<p>Hello {{name}}</p>",
      textBody: "Hello {{name}}",
      fromAddress: null,
    }]);

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "primary@example.com",
        bccEmails: ["alpha-private@example.com"],
        metadata: { name: "Primary" },
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.subject).toBe("Welcome Primary");
    expect(body.htmlBody).toBe("<p>Hello Primary</p>");
    expect(body.textBody).toBe("Hello Primary");
    expect(body.subject).not.toContain("alpha-private@example.com");
    expect(body.htmlBody).not.toContain("alpha-private@example.com");
    expect(body.textBody).not.toContain("alpha-private@example.com");

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.metadata).toEqual({ name: "Primary" });
  });

  it("passes brandIds and campaignId when provided", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "user_active",
        brandIds: ["brand_abc"],
        campaignId: "campaign_def",
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.brandIds).toBeUndefined();
    expect(body.campaignId).toBe("campaign_def");
  });

  it("updates event status to 'sent' only after successful gateway delivery", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(true);

    // Should have called db.update to set status to "sent"
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith({ status: "sent" });
  });

  it("updates event status to 'failed' when gateway returns an error", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Gateway down" }),
    });

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(false);

    // Should have called db.update to set status to "failed"
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });

  it("returns 404 when event type has no template", async () => {
    mockSelectLimit.mockResolvedValueOnce([]);

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "nonexistent_event",
        recipientEmail: "user@example.com",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("No template for event");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("updates event status to 'failed' for non-deduped events when gateway fails", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Gateway down" }),
    });

    // signin_notification is a repeatable (non-deduped) event
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "signin_notification",
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(false);

    // Should still update the event to "failed" even without a dedup key
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });

  it("passes orgId and userId to updateRun for identity headers", async () => {
    const { updateRun } = await import("../../src/lib/runs-client.js");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(true);
    expect(vi.mocked(updateRun)).toHaveBeenCalledWith(
      "run-456",
      "completed",
      { orgId: "org_456", userId: "user_123" },
      { campaignId: undefined, brandId: undefined, workflowSlug: undefined, featureSlug: undefined },
    );
  });

  it("passes x-run-id header to createRun as parentRunId for runs-service", async () => {
    const { createRun } = await import("../../src/lib/runs-client.js");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .set("x-user-id", "user_123")
      .set("x-run-id", "caller-run-789")
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(200);
    expect(vi.mocked(createRun)).toHaveBeenCalledWith(
      expect.objectContaining({ parentRunId: "caller-run-789" })
    );
  });

  it("forwards workflow tracking headers to downstream services", async () => {
    const { createRun, updateRun } = await import("../../src/lib/runs-client.js");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .set("x-user-id", "user_123")
      .set("x-run-id", "run-789")
      .set("x-campaign-id", "camp_123")
      .set("x-brand-id", "brand_456,brand_789")
      .set("x-workflow-slug", "onboarding-flow")
      .set("x-feature-slug", "feat_abc")
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(true);

    // Workflow headers forwarded to createRun (brandId is joined CSV for header forwarding)
    expect(vi.mocked(createRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowHeaders: { campaignId: "camp_123", brandId: "brand_456,brand_789", workflowSlug: "onboarding-flow", featureSlug: "feat_abc" },
      })
    );

    // Workflow headers forwarded to email gateway via fetch
    const gatewayCall = fetchSpy.mock.calls.find((c: any[]) => String(c[0]).includes("/send"));
    expect(gatewayCall).toBeDefined();
    const gatewayHeaders = gatewayCall![1].headers;
    expect(gatewayHeaders["x-campaign-id"]).toBe("camp_123");
    expect(gatewayHeaders["x-brand-id"]).toBe("brand_456,brand_789");
    expect(gatewayHeaders["x-workflow-slug"]).toBe("onboarding-flow");
    expect(gatewayHeaders["x-feature-slug"]).toBe("feat_abc");

    // Workflow headers forwarded to updateRun
    expect(vi.mocked(updateRun)).toHaveBeenCalledWith(
      "run-456",
      "completed",
      { orgId: "org_456", userId: "user_123" },
      { campaignId: "camp_123", brandId: "brand_456,brand_789", workflowSlug: "onboarding-flow", featureSlug: "feat_abc" }
    );
  });

  it("uses header brand IDs over body values", async () => {
    const { createRun } = await import("../../src/lib/runs-client.js");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .set("x-user-id", "user_123")
      .set("x-run-id", "run-789")
      .set("x-campaign-id", "header_campaign")
      .set("x-brand-id", "header_brand")
      .send({
        eventType: "user_active",
        campaignId: "body_campaign",
        brandIds: ["body_brand"],
      });

    expect(res.status).toBe(200);

    // Header values take precedence over body values
    expect(vi.mocked(createRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: "header_campaign",
        brandIds: ["header_brand"],
      })
    );
  });

  it("stores feature_slug in email_events when x-feature-slug header is present", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-feature-slug", "my-feature")
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(200);

    // Check that db.insert was called with featureSlug
    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.featureSlug).toBe("my-feature");
  });

  it("works without workflow headers (backward compatible)", async () => {
    const { createRun } = await import("../../src/lib/runs-client.js");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(true);

    // No workflow headers = undefined values, no crash
    expect(vi.mocked(createRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowHeaders: { campaignId: undefined, brandId: undefined, workflowSlug: undefined, featureSlug: undefined },
      }),
    );
  });

  it("parses multi-brand CSV header into array for createRun", async () => {
    const { createRun } = await import("../../src/lib/runs-client.js");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .set("x-user-id", "user_123")
      .set("x-run-id", "run-789")
      .set("x-brand-id", "brand_a, brand_b, brand_c")
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(200);

    // brandIds should be parsed as an array
    expect(vi.mocked(createRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        brandIds: ["brand_a", "brand_b", "brand_c"],
      })
    );
  });

  it("stores brandIds array in email_events insert", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_x,brand_y")
      .send({
        eventType: "user_active",
      });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.brandIds).toEqual(["brand_x", "brand_y"]);
  });

  it("propagates inbound x-audience-id to the run, the gateway egress, and the email_events row", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-audience-id", "aud_priority_1")
      .set("x-feature-slug", "sales-cold-email-outreach")
      .send({
        eventType: "campaign_created",
        recipientEmail: "primary@example.com",
      });

    expect(res.status).toBe(200);

    // 1. Run creation carries audienceId (runs-service reads x-audience-id → runs.audience_id)
    expect(vi.mocked(createRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowHeaders: expect.objectContaining({ audienceId: "aud_priority_1" }),
      })
    );

    // 2. Internal egress to email-gateway forwards the header
    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-audience-id"]).toBe("aud_priority_1");

    // 3. Own DB row is tagged
    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.audienceId).toBe("aud_priority_1");
  });

  it("omits audienceId everywhere when x-audience-id is absent (optional, no throw)", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "primary@example.com",
      });

    expect(res.status).toBe(200);

    expect(vi.mocked(createRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowHeaders: expect.objectContaining({ audienceId: undefined }),
      })
    );

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-audience-id"]).toBeUndefined();

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.audienceId).toBeNull();
  });
});

describe("POST /send — audience_fully_contacted monthly per-brand dedup", () => {
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

  it("builds a per-(org, brand, month) dedup key from the x-brand-id header", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_cold")
      .send({ eventType: "audience_fully_contacted" });

    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(true);

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBe(`org_456:audience_fully_contacted:brand_cold:${currentMonth}`);
  });

  it("returns duplicate (not delivered) on a second send for same org+brand+month", async () => {
    // Simulate the unique-index conflict: onConflictDoNothing returns no rows
    mockReturning.mockResolvedValueOnce([]);

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_cold")
      .send({ eventType: "audience_fully_contacted" });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "user@example.com", sent: false, reason: "duplicate" }]);
    // No gateway delivery on a duplicate
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keys on canonical-sorted brand set so member order does not matter", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_z,brand_a")
      .send({ eventType: "audience_fully_contacted" });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBe(`org_456:audience_fully_contacted:brand_a,brand_z:${currentMonth}`);
  });

  it("produces a different key for a different brand (so a different brand goes through)", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_other")
      .send({ eventType: "audience_fully_contacted" });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBe(`org_456:audience_fully_contacted:brand_other:${currentMonth}`);
  });

  it("prefers the x-brand-id header over the body brandIds for the dedup key", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "header_brand")
      .send({ eventType: "audience_fully_contacted", brandIds: ["body_brand"] });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBe(`org_456:audience_fully_contacted:header_brand:${currentMonth}`);
  });

  it("uses body brandIds when no x-brand-id header is present", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "audience_fully_contacted", brandIds: ["body_brand"] });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBe(`org_456:audience_fully_contacted:body_brand:${currentMonth}`);
  });

  it("falls through to no-dedup (repeatable) when no brand identity is present", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "audience_fully_contacted" });

    // No brand → null dedup key → repeatable insert path (no onConflictDoNothing)
    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBeNull();
    expect(mockOnConflictDoNothing).not.toHaveBeenCalled();
  });
});

describe("POST /send — existing dedup cadences unchanged (regression)", () => {
  it("once-only (welcome) keys on org+eventType+userId, no month/brand", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_cold")
      .send({ eventType: "welcome" });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBe("org_456:welcome:user_123");
  });

  it("daily (user_active) keys on org+eventType+identifier+date, unaffected by brand", async () => {
    const today = new Date().toISOString().split("T")[0];
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_cold")
      .send({ eventType: "user_active" });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBe(`org_456:user_active:user_123:${today}`);
  });

  it("product-scoped (webinar_welcome) keys on org+eventType+email+productId", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_cold")
      .send({ eventType: "webinar_welcome", recipientEmail: "primary@example.com", productId: "webinar_42" });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBe("org_456:webinar_welcome:primary@example.com:webinar_42");
  });

  it("unknown event type still has no dedup (repeatable)", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_cold")
      .send({ eventType: "some_random_event", recipientEmail: "primary@example.com" });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBeNull();
    expect(mockOnConflictDoNothing).not.toHaveBeenCalled();
  });
});

describe("POST /send — brand_daily_budget_changed staff notification", () => {
  it("delivers to the staff recipient list, never to the customer from x-user-id", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValue("customer@example.com");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "brand_daily_budget_changed",
        metadata: { brandName: "Acme", previousBudget: "50", newBudget: "0" },
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin@distribute.you", sent: true }]);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.to).toBe("kevin@distribute.you");
    expect(body.to).not.toBe("customer@example.com");
  });

  it("enriches metadata with the acting user's email", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValue("actor@example.com");

    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "brand_daily_budget_changed", metadata: { brandName: "Acme" } });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.metadata).toMatchObject({ brandName: "Acme", email: "actor@example.com" });
  });

  it("applies no dedup — two sends on the same day both deliver", async () => {
    const first = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_alpha")
      .send({ eventType: "brand_daily_budget_changed", metadata: { newBudget: "80" } });

    const second = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_alpha")
      .send({ eventType: "brand_daily_budget_changed", metadata: { newBudget: "0" } });

    expect(first.body.results[0].sent).toBe(true);
    expect(second.body.results[0].sent).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    for (const call of mockValues.mock.calls) {
      expect(call[0].dedupKey).toBeNull();
    }
    expect(mockOnConflictDoNothing).not.toHaveBeenCalled();
  });
});
