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
    // Admin-notification events fan out to both admin recipients
    expect(fetchSpy).toHaveBeenCalledTimes(2);

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
    // Admin-notification events fan out to both admin recipients
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.brandIds).toBeUndefined();
    expect(body.campaignId).toBeUndefined();
    expect(body.bcc).toBeUndefined();
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
    expect(body.bcc).toBe("alpha1@example.com,alpha2@example.com");
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
