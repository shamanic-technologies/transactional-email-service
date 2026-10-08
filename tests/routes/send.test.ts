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
    layout: "brand",
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
import { brandLayout } from "../../src/lib/brand-layout.js";
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
  layout: "brand",
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
    // user_active is staff-routed: the founder is already the primary recipient,
    // so a blind copy to him would deliver the same message twice
    expect(body).not.toHaveProperty("bcc");
    // Replies reach a human on every send, staff-routed included
    expect(body.replyTo).toBe("kevin@distribute.you");
  });

  it("blind-copies the founder on a customer-facing send", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "customer@example.com",
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    // The company sees what it tells a customer, as it tells them. One address,
    // never a staff list: Postmark bills per recipient and counts blind copies.
    expect(body.to).toBe("customer@example.com");
    expect(body.bcc).toBe("kevin@distribute.you");
    expect(body.replyTo).toBe("kevin@distribute.you");
  });

  it("forwards a caller's replyToEmail as the Reply-To instead of the founder", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "customer@example.com",
        replyToEmail: "prospect@acme.com",
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    // Hitting Reply addresses the third party the caller named
    expect(body.to).toBe("customer@example.com");
    expect(body.replyTo).toBe("prospect@acme.com");
    // The blind copy is untouched by a named reply address
    expect(body.bcc).toBe("kevin@distribute.you");
    // Never rendered into stored metadata
    expect(JSON.stringify(body)).not.toContain("replyToEmail");
  });

  it("refuses a malformed replyToEmail", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "customer@example.com",
        replyToEmail: "not-an-email",
      });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a caller's bccEmails and adds the founder to them", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "customer@example.com",
        bccEmails: ["ops@example.com"],
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    // Combined, not replaced — nothing the caller asked for is lost
    expect(body.bcc).toBe("ops@example.com,kevin@distribute.you");
  });

  it("does not double the founder when a caller already named him", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "customer@example.com",
        bccEmails: ["kevin@distribute.you"],
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.bcc).toBe("kevin@distribute.you");
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
    // The caller's list in the order it supplied, with the founder appended —
    // the standing blind copy adds to what a caller asked for, never replaces it
    expect(body.bcc).toBe("alpha1@example.com,alpha2@example.com,kevin@distribute.you");
  });

  it("forwards ccEmails to the provider payload as cc", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "prospect@example.com",
        ccEmails: ["rep@client.com", "manager@client.com"],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "prospect@example.com", sent: true }]);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.to).toBe("prospect@example.com");
    // Visible: the addresses land on a header every recipient reads, in the
    // order the caller supplied, and a reply-all reaches them
    expect(body.cc).toBe("rep@client.com,manager@client.com");
  });

  it("adds nothing to a caller's ccEmails — no founder, no standing address", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "prospect@example.com",
        ccEmails: ["rep@client.com"],
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.cc).toBe("rep@client.com");
    // The blind copy is untouched by the visible one: the founder is still
    // blind-copied on a customer-facing send and is NOT added to the Cc
    expect(body.bcc).toBe("kevin@distribute.you");
  });

  it("sends no cc at all when a caller names none", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "customer@example.com",
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    // Byte for byte what a send looked like before visible copy existed:
    // the key is absent from the payload, not present and empty
    expect("cc" in body).toBe(false);
    expect(body.bcc).toBe("kevin@distribute.you");
  });

  it("sends no cc when a caller supplies an empty ccEmails list", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "customer@example.com",
        ccEmails: [],
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    expect("cc" in JSON.parse(options.body)).toBe(false);
  });

  it("refuses a malformed ccEmails address rather than dropping it", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "customer@example.com",
        ccEmails: ["rep@client.com", "not-an-email"],
      });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not render ccEmails into primary-recipient content or metadata", async () => {
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
        ccEmails: ["rep@client.com"],
        metadata: { name: "Primary" },
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.subject).toBe("Welcome Primary");
    expect(body.htmlBody).not.toContain("rep@client.com");
    expect(body.textBody).not.toContain("rep@client.com");

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.metadata).toEqual({ name: "Primary" });
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
    expect(body.htmlBody).toMatch(/^<p>Hello Primary<\/p>\n<p [^>]*>Revenue made easy\.<\/p>$/);
    expect(body.textBody).toBe("Hello Primary\n\nRevenue made easy.");
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

  it("once-only (first_payment) keys on org+eventType+userId like welcome, and a repeat send is deduped", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .set("x-brand-id", "brand_cold")
      .send({ eventType: "first_payment" });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.dedupKey).toBe("org_456:first_payment:user_123");
    expect(mockOnConflictDoNothing).toHaveBeenCalled();
  });

  it("first_payment: a second send for the same org+user is a duplicate, not delivered", async () => {
    // Simulate the unique-index conflict: onConflictDoNothing returns no rows
    mockReturning.mockResolvedValueOnce([]);

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "first_payment" });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "user@example.com", sent: false, reason: "duplicate" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
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
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.to).toBe("kevin.lourd@gmail.com");
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

describe("staff-routed events — no alert to the staff member who did it", () => {
  it("skips the send when the enriched actor is the staff recipient", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValueOnce("kevin.lourd@gmail.com");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "brand_daily_budget_changed", metadata: { brandName: "Acme", newBudget: "0" } });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: false, reason: "self_action" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("matches a caller-supplied actor email trimmed and case-insensitively", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set({ "x-org-id": "org_456" })
      .send({ eventType: "payment_method_removed", metadata: { email: "  Kevin.Lourd@GMAIL.com " } });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: false, reason: "self_action" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips the staff recipient when the same person acts under another address", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValueOnce("Kevin@Distribute.you");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "brand_daily_budget_changed", metadata: { brandName: "Acme", newBudget: "0" } });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: false, reason: "self_action" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("still sends when the actor is a customer", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValue("customer@example.com");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "brand_daily_budget_changed", metadata: { brandName: "Acme" } });

    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).to).toBe("kevin.lourd@gmail.com");
  });

  it("still sends a staff event with no acting person", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set({ "x-org-id": "org_456" })
      .send({ eventType: "payment_method_removed", metadata: { cardLast4: "4242" } });

    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never applies to a customer-facing event, even when staff is the recipient", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "welcome", recipientEmail: "kevin.lourd@gmail.com", metadata: { email: "kevin.lourd@gmail.com" } });

    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);
  });
});

describe("POST /platform-send — payment_method_removed (no acting user)", () => {
  const ORG_ONLY = { "x-org-id": "org_456" };

  it("sends with an org and an API key but no end-user identity", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({
        eventType: "payment_method_removed",
        metadata: { organizationId: "org_456", cardBrand: "visa", cardLast4: "4242", remainingChargeableCards: "0" },
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);
  });

  it("delivers to the staff recipient list, never to the customer", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValue("customer@example.com");

    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "payment_method_removed", metadata: { cardLast4: "4242" } });

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.to).toBe("kevin.lourd@gmail.com");
    expect(resolveUserEmail).not.toHaveBeenCalled();
  });

  it("stores no user and forwards no x-user-id when there is no acting user", async () => {
    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "payment_method_removed", metadata: { cardLast4: "4242" } });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.userId).toBeNull();
    expect(insertValues.metadata).not.toHaveProperty("email");

    expect(vi.mocked(createRun).mock.calls[0][0]).toMatchObject({ orgId: "org_456" });
    expect(vi.mocked(createRun).mock.calls[0][0].userId).toBeUndefined();

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-user-id"]).toBeUndefined();
    expect(options.headers["x-org-id"]).toBe("org_456");
  });

  it("applies no dedup — every removal sends", async () => {
    const first = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "payment_method_removed", metadata: { cardLast4: "4242", remainingChargeableCards: "1" } });

    const second = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "payment_method_removed", metadata: { cardLast4: "1881", remainingChargeableCards: "0" } });

    expect(first.body.results[0].sent).toBe(true);
    expect(second.body.results[0].sent).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    for (const call of mockValues.mock.calls) {
      expect(call[0].dedupKey).toBeNull();
    }
    expect(mockOnConflictDoNothing).not.toHaveBeenCalled();
  });

  it("honours x-user-id and x-run-id when the caller does have them", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValue("actor@example.com");

    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "payment_method_removed", metadata: { cardLast4: "4242" } });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.userId).toBe("user_123");
    expect(insertValues.metadata).toMatchObject({ email: "actor@example.com" });
  });

  it("rejects a request with no API key", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set(ORG_ONLY)
      .send({ eventType: "payment_method_removed" });

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a request with no x-org-id", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .send({ eventType: "payment_method_removed" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a customer-bound event type", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "welcome", recipientEmail: "customer@example.com" });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects recipientEmail, bccEmails, ccEmails and replyToEmail", async () => {
    const withRecipient = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "payment_method_removed", recipientEmail: "customer@example.com" });

    const withBcc = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "payment_method_removed", bccEmails: ["customer@example.com"] });

    const withCc = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "payment_method_removed", ccEmails: ["customer@example.com"] });

    const withReplyTo = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "payment_method_removed", replyToEmail: "customer@example.com" });

    expect(withRecipient.status).toBe(400);
    expect(withBcc.status).toBe(400);
    expect(withCc.status).toBe(400);
    expect(withReplyTo.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /send — payment_method_removed staff routing", () => {
  it("delivers to staff, not the customer, when called with an acting user", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValue("customer@example.com");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "payment_method_removed", metadata: { cardLast4: "4242" } });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);
  });

  it("still requires the full identity headers on /send", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .send({ eventType: "payment_method_removed" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-user-id");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("provider_credits_exhausted — a paid provider has run out of credits", () => {
  const ORG_ONLY = { "x-org-id": "org_456" };
  const today = new Date().toISOString().split("T")[0];
  const ALERT = {
    eventType: "provider_credits_exhausted",
    metadata: {
      provider: "Apollo.io",
      reason: "people/search returned 402 with credits_remaining: 0 on 3 consecutive calls",
      detail: 'HTTP 402 {"error":"insufficient_credits","credits_remaining":0}',
    },
  };

  it("is raised with an org and an API key and no acting user, and reaches the staff list", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send(ALERT);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);

    const [, options] = fetchSpy.mock.calls[0];
    expect(JSON.parse(options.body).to).toBe("kevin.lourd@gmail.com");
    // No acting user was invented to make the send possible
    expect(options.headers["x-user-id"]).toBeUndefined();
    expect(mockValues.mock.calls[0][0].userId).toBeNull();
  });

  it("carries the caller's context through to the rendered email", async () => {
    mockSelectLimit.mockResolvedValueOnce([{
      name: "provider_credits_exhausted",
      subject: "{{provider}} is out of credits",
      htmlBody: "<p>{{provider}} — {{reason}} — {{orgId}} — {{detail}}</p>",
      textBody: "{{provider}} {{reason}} {{orgId}} {{detail}}",
      fromAddress: null,
    }]);

    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send(ALERT);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.subject).toBe("Apollo.io is out of credits");
    expect(body.htmlBody).toContain("people/search returned 402");
    expect(body.htmlBody).toContain("insufficient_credits");
    // The affected org comes off the request, not off the caller's metadata
    expect(body.htmlBody).toContain("org_456");
  });

  it("mails once per org per calendar day, and reports the repeat as a duplicate", async () => {
    const first = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send(ALERT);

    expect(first.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);
    expect(mockValues.mock.calls[0][0].dedupKey).toBe(`org_456:provider_credits_exhausted:${today}`);
    expect(mockOnConflictDoNothing).toHaveBeenCalled();

    // A second call the same day loses the race on the unique dedup index
    mockReturning.mockResolvedValueOnce([]);
    const second = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send(ALERT);

    expect(second.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: false, reason: "duplicate" }]);
    // Exactly one email left the building
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keys on the org, so a different org still gets its own alert the same day", async () => {
    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set({ "x-org-id": "org_other" })
      .send(ALERT);

    expect(mockValues.mock.calls[0][0].dedupKey).toBe(`org_other:provider_credits_exhausted:${today}`);
  });

  it("keys on the day, so tomorrow the same org can alert again", async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // Only the clock is faked: supertest still needs real timers to run a request
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(tomorrow);

    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send(ALERT);

    const expected = tomorrow.toISOString().split("T")[0];
    expect(mockValues.mock.calls[0][0].dedupKey).toBe(`org_456:provider_credits_exhausted:${expected}`);
    expect(expected).not.toBe(today);

    vi.useRealTimers();
  });

  it("puts no recipient or user in the key, so a caller with an acting user dedupes identically", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send(ALERT);

    expect(mockValues.mock.calls[0][0].dedupKey).toBe(`org_456:provider_credits_exhausted:${today}`);
  });

  it("goes to staff on /send too, never to the customer resolved from x-user-id", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValue("customer@example.com");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send(ALERT);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).to).toBe("kevin.lourd@gmail.com");
  });

  it("cannot be aimed at a customer address on either route", async () => {
    for (const route of ["/send", "/platform-send"]) {
      const headers = route === "/send" ? HEADERS : ORG_ONLY;

      const withRecipient = await request(app)
        .post(route)
        .set("X-API-Key", "test-service-key")
        .set(headers)
        .send({ ...ALERT, recipientEmail: "customer@example.com" });

      const withBcc = await request(app)
        .post(route)
        .set("X-API-Key", "test-service-key")
        .set(headers)
        .send({ ...ALERT, bccEmails: ["customer@example.com"] });

      const withCc = await request(app)
        .post(route)
        .set("X-API-Key", "test-service-key")
        .set(headers)
        .send({ ...ALERT, ccEmails: ["customer@example.com"] });

      const withReplyTo = await request(app)
        .post(route)
        .set("X-API-Key", "test-service-key")
        .set(headers)
        .send({ ...ALERT, replyToEmail: "customer@example.com" });

      expect(withRecipient.status).toBe(400);
      expect(withBcc.status).toBe(400);
      expect(withCc.status).toBe(400);
      expect(withReplyTo.status).toBe(400);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an alert that names no provider or no reason", async () => {
    const noProvider = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "provider_credits_exhausted", metadata: { reason: "402 on every call" } });

    const noReason = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "provider_credits_exhausted", metadata: { provider: "Apollo.io" } });

    const blankProvider = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "provider_credits_exhausted", metadata: { provider: "  ", reason: "402" } });

    expect(noProvider.status).toBe(400);
    expect(noProvider.body.error).toContain("provider");
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain("reason");
    expect(blankProvider.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts an alert with no upstream detail — detail is optional", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "provider_credits_exhausted", metadata: { provider: "Apollo.io", reason: "402" } });

    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(true);
  });

  it("still needs an org, and an API key", async () => {
    const noOrg = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .send(ALERT);

    const noKey = await request(app)
      .post("/platform-send")
      .set(ORG_ONLY)
      .send(ALERT);

    expect(noOrg.status).toBe(400);
    expect(noKey.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("campaign_failing — a campaign has failed every run for a sustained stretch", () => {
  const ORG_ONLY = { "x-org-id": "org_456" };
  const today = new Date().toISOString().split("T")[0];
  const ALERT = {
    eventType: "campaign_failing",
    metadata: {
      campaignId: "3922c8e1-3405-46af-8a56-1eef3f221b19",
      campaignName: "Shockwave cold email",
      consecutiveFailures: 8,
      failingSince: "2026-10-04T00:35:40.000Z",
      retryInterval: "30 min",
    },
  };

  it("is raised with an org and an API key and reaches the staff list only", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send(ALERT);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).to).toBe("kevin.lourd@gmail.com");
  });

  it("mails once per campaign per calendar day", async () => {
    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send(ALERT);

    expect(mockValues.mock.calls[0][0].dedupKey).toBe(
      `org_456:campaign_failing:3922c8e1-3405-46af-8a56-1eef3f221b19:${today}`,
    );

    mockReturning.mockResolvedValueOnce([]);
    const second = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send(ALERT);

    expect(second.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: false, reason: "duplicate" }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keys on the campaign, so a second failing campaign of the same org still alerts", async () => {
    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ ...ALERT, metadata: { ...ALERT.metadata, campaignId: "cb528e24-a4c5-4046-ad81-1f069bd62fa9" } });

    expect(mockValues.mock.calls[0][0].dedupKey).toBe(
      `org_456:campaign_failing:cb528e24-a4c5-4046-ad81-1f069bd62fa9:${today}`,
    );
  });

  it("cannot be aimed at a customer address", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ ...ALERT, recipientEmail: "customer@example.com" });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an alert that names no campaign", async () => {
    const { campaignId: _omit, ...rest } = ALERT.metadata;
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "campaign_failing", metadata: rest });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("campaignId");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("audience_refill_failed — out of people and the automatic refill gave nobody new", () => {
  const STAFF_HEADERS = {
    "x-org-id": "org_456",
    "x-user-id": "user_789",
    "x-run-id": "run_abc",
    "x-campaign-id": "3922c8e1-3405-46af-8a56-1eef3f221b19",
    "x-brand-id": "brand_1",
    "x-feature-slug": "sales-cold-email-outreach",
  };
  const today = new Date().toISOString().split("T")[0];
  const ALERT = {
    eventType: "audience_refill_failed",
    metadata: {
      campaignId: "3922c8e1-3405-46af-8a56-1eef3f221b19",
      campaignName: "Shockwave cold email",
      brandId: "brand_1",
      brandName: "Shockwave",
      refillOutcome: "cooldown",
      refillDetail: "last refill 2h ago",
      whereToLook: "SELECT * FROM campaigns WHERE id = '3922c8e1'",
    },
  };

  it("is accepted on the platform send route and reaches the staff list, never the campaign owner", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(STAFF_HEADERS)
      .send(ALERT);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.to).toBe("kevin.lourd@gmail.com");
    expect(body).not.toHaveProperty("bcc");
  });

  it("mails once per campaign per calendar day, on a key distinct from campaign_failing", async () => {
    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(STAFF_HEADERS)
      .send(ALERT);

    expect(mockValues.mock.calls[0][0].dedupKey).toBe(
      `org_456:audience_refill_failed:3922c8e1-3405-46af-8a56-1eef3f221b19:${today}`,
    );

    mockReturning.mockResolvedValueOnce([]);
    const second = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(STAFF_HEADERS)
      .send(ALERT);

    expect(second.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: false, reason: "duplicate" }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("cannot be aimed at a customer address", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ ...ALERT, recipientEmail: "customer@example.com" });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an alert that does not say why the refill failed", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(STAFF_HEADERS)
      .send({ eventType: "audience_refill_failed", metadata: { ...ALERT.metadata, refillOutcome: " " } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("refillOutcome");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts an empty brand name and refill detail", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(STAFF_HEADERS)
      .send({ ...ALERT, metadata: { ...ALERT.metadata, brandName: "", refillDetail: "" } });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);
  });
});

describe("staff_daily_digest", () => {
  const ORG_ONLY = { "x-org-id": "org_456" };

  it("is accepted on the platform send route and delivered to the staff recipient", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "staff_daily_digest", metadata: { signups: "3" } });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.to).toBe("kevin.lourd@gmail.com");
    expect(body).not.toHaveProperty("bcc");
  });

  it("goes to staff on /send too, never to the customer resolved from x-user-id", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValue("customer@example.com");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "staff_daily_digest", recipientEmail: "customer@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);

    const [, options] = fetchSpy.mock.calls[0];
    expect(JSON.parse(options.body).to).toBe("kevin.lourd@gmail.com");
  });

  it("cannot carry a customer blind copy in on the platform route", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "staff_daily_digest", bccEmails: ["customer@example.com"] });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cannot carry a customer visible copy in on the platform route", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "staff_daily_digest", ccEmails: ["customer@example.com"] });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves provider_credits_exhausted alone: it is deduped, the digest is not", async () => {
    const today = new Date().toISOString().split("T")[0];

    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "staff_daily_digest" });

    expect(mockValues.mock.calls[0][0].dedupKey).toBeNull();

    await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "provider_credits_exhausted", metadata: { provider: "Apollo.io", reason: "402" } });

    expect(mockValues.mock.calls[1][0].dedupKey).toBe(`org_456:provider_credits_exhausted:${today}`);
  });

  it("applies no dedup — a digest sends every day it is requested", async () => {
    const first = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "staff_daily_digest" });

    const second = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "staff_daily_digest" });

    expect(first.body.results[0].sent).toBe(true);
    expect(second.body.results[0].sent).toBe(true);
    for (const call of mockValues.mock.calls) {
      expect(call[0].dedupKey).toBeNull();
    }
  });
});

describe("unpaid_debt_uncollectable", () => {
  const ORG_ONLY = { "x-org-id": "org_456" };

  it("is accepted on the platform send route and delivered to the staff recipient", async () => {
    const res = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "unpaid_debt_uncollectable", metadata: { balanceCents: "-4200" } });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.to).toBe("kevin.lourd@gmail.com");
    expect(body).not.toHaveProperty("bcc");
  });

  it("goes to staff on /send too, never to the customer resolved from x-user-id", async () => {
    const { resolveUserEmail } = await import("../../src/lib/client-service.js");
    vi.mocked(resolveUserEmail).mockResolvedValue("customer@example.com");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "unpaid_debt_uncollectable" });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ email: "kevin.lourd@gmail.com", sent: true }]);

    const [, options] = fetchSpy.mock.calls[0];
    expect(JSON.parse(options.body).to).toBe("kevin.lourd@gmail.com");
  });

  it("applies no dedup — every uncollectable debt billing-service reports is news", async () => {
    const first = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "unpaid_debt_uncollectable" });

    const second = await request(app)
      .post("/platform-send")
      .set("X-API-Key", "test-service-key")
      .set(ORG_ONLY)
      .send({ eventType: "unpaid_debt_uncollectable" });

    expect(first.body.results[0].sent).toBe(true);
    expect(second.body.results[0].sent).toBe(true);
    for (const call of mockValues.mock.calls) {
      expect(call[0].dedupKey).toBeNull();
    }
  });
});

describe("the why under a distribute.you email", () => {
  const send = (eventType: string, extra: Record<string, unknown> = {}) =>
    request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType, recipientEmail: "customer@example.com", ...extra });

  const wire = () => JSON.parse(fetchSpy.mock.calls[0][1].body);

  it("signs a customer-facing email, inside the document, in both parts", async () => {
    mockSelectLimit.mockResolvedValueOnce([{
      ...DB_TEMPLATE_ROW,
      htmlBody: "<html><body><div>Hi</div></body></html>",
      textBody: "Hi",
    }]);

    await send("welcome");

    const body = wire();
    expect(body.htmlBody).toMatch(/<div>Hi<\/div><p [^>]*>Revenue made easy\.<\/p>\n<\/body><\/html>$/);
    expect(body.textBody).toBe("Hi\n\nRevenue made easy.");
    // The newsletter's "Get started" link is not on a lifecycle email.
    expect(body.htmlBody).not.toContain("Get started");
  });

  it("leaves the subject alone", async () => {
    await send("welcome");
    expect(wire().subject).toBe("Test subject");
  });

  it("does not sign a staff-routed alert", async () => {
    await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "signup_notification" });

    expect(wire().htmlBody).toBe("<p>Test</p>");
    expect(wire().textBody).toBe("Test");
  });

  it("does not sign a template that sends as another brand", async () => {
    mockSelectLimit.mockResolvedValueOnce([{ ...DB_TEMPLATE_ROW, fromAddress: "GrowthAgency.dev <hello@growthagency.dev>" }]);

    await send("checkout_success");

    expect(wire().htmlBody).toBe("<p>Test</p>");
    expect(wire().textBody).toBe("Test");
  });

  it("signs a template that names a distribute.you sender of its own", async () => {
    mockSelectLimit.mockResolvedValueOnce([{ ...DB_TEMPLATE_ROW, fromAddress: "Kevin <kevin@news.distribute.you>" }]);

    await send("welcome");

    expect(wire().textBody).toBe("Test\n\n--\ndistribute.you\nRevenue made easy.");
  });

  it("does not sign twice a template that already says it", async () => {
    const doc = "<html><body><p>Hi</p><p>Revenue made easy.</p></body></html>";
    mockSelectLimit.mockResolvedValueOnce([{
      ...DB_TEMPLATE_ROW,
      htmlBody: doc,
      textBody: "Hi\n\nRevenue made easy.",
    }]);

    await send("welcome");

    expect(wire().htmlBody).toBe(doc);
    expect(wire().textBody).toBe("Hi\n\nRevenue made easy.");
  });
});

describe("the distribute.you layout around a customer email", () => {
  const send = (eventType: string, extra: Record<string, unknown> = {}) =>
    request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType, recipientEmail: "customer@example.com", ...extra });

  const wire = () => JSON.parse(fetchSpy.mock.calls[0][1].body);

  it("wraps a bare customer fragment in the layout, card content included as registered", async () => {
    mockSelectLimit.mockResolvedValueOnce([{
      ...DB_TEMPLATE_ROW,
      htmlBody: "<p>Your card ending {{last4}} was declined.</p>",
      textBody: "Your card ending {{last4}} was declined.",
    }]);

    await send("credit-card-unusable", { metadata: { last4: "4242" } });

    const { htmlBody, textBody } = wire();
    expect(htmlBody.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(htmlBody).toBe(brandLayout("<p>Your card ending 4242 was declined.</p>"));
    expect(htmlBody).toContain("background-color:#fafaf8");
    expect(htmlBody).toContain("max-width:560px");
    expect(htmlBody).toContain("border:1px solid rgba(10,10,20,0.08);border-radius:12px;padding:36px 32px;");
    // The header is the official logo image, never the old typed wordmark + blue dot.
    expect(htmlBody).toContain(
      '<div style="margin-bottom:28px;"><img src="https://distribute.you/brand/logo-full-on-light.png" width="170" height="32" alt="distribute.you" style="display:block;border:0;outline:none;text-decoration:none;height:32px;width:170px;" /></div>',
    );
    expect(htmlBody).not.toContain(">distribute.you</span>");
    expect(htmlBody).not.toContain("border-radius:50%");
    expect(htmlBody).not.toContain("#3D80FF");
    expect(htmlBody).toContain("Done-for-you cold outreach, sent from our domains on your behalf.");
    expect(htmlBody).toContain('href="https://dashboard.distribute.you"');
    expect(htmlBody).toContain('href="https://docs.distribute.you"');
    // The footer carries the why once; nothing is signed in a second time.
    expect(htmlBody.match(/Revenue made easy\./g)).toHaveLength(1);
    expect(textBody).toBe("Your card ending 4242 was declined.\n\n--\ndistribute.you\nRevenue made easy.");
  });

  it("leaves a full HTML document's markup untouched", async () => {
    const doc = "<!DOCTYPE html>\n<html><body><p>Hi</p><p>Revenue made easy.</p></body></html>";
    mockSelectLimit.mockResolvedValueOnce([{ ...DB_TEMPLATE_ROW, htmlBody: doc, textBody: "Hi\n\n--\ndistribute.you\nRevenue made easy." }]);

    await send("campaign_created");

    expect(wire().htmlBody).toBe(doc);
    expect(wire().textBody).toBe("Hi\n\n--\ndistribute.you\nRevenue made easy.");
  });

  it("does not wrap a {{html}} template whose caller supplies a full document", async () => {
    const doc = "<!doctype html><html><body><p>Yes!</p></body></html>";
    mockSelectLimit.mockResolvedValueOnce([{ ...DB_TEMPLATE_ROW, htmlBody: "{{html}}", textBody: "{{text}}" }]);

    await send("positive-reply-celebration", { metadata: { html: doc, text: "Yes!" } });

    expect(wire().htmlBody.startsWith(doc.replace("</body></html>", ""))).toBe(true);
    expect(wire().htmlBody).not.toContain("Done-for-you cold outreach");
  });

  it("does not wrap a template registered with layout none", async () => {
    mockSelectLimit.mockResolvedValueOnce([{ ...DB_TEMPLATE_ROW, htmlBody: "<p>Escalated</p>", textBody: "Escalated", layout: "none" }]);

    await send("reply-escalation");

    expect(wire().htmlBody).not.toContain("<!DOCTYPE html>");
    expect(wire().htmlBody.startsWith("<p>Escalated</p>")).toBe(true);
  });

  it("sends a person-to-person template as registered, on the transactional stream, Reply-To kept", async () => {
    mockSelectLimit.mockResolvedValueOnce([{
      ...DB_TEMPLATE_ROW,
      name: "positive-reply-answer-request",
      subject: "{{subject}}",
      htmlBody: "{{html}}",
      textBody: "{{text}}",
      layout: "none",
      stream: "transactional",
    }]);

    await send("positive-reply-answer-request", {
      replyToEmail: "prospect@example.com",
      metadata: { subject: "They answered", html: "<p>Hi, answer them.</p>", text: "Hi, answer them." },
    });

    const body = wire();
    expect(body.stream).toBe("transactional");
    expect(body.replyTo).toBe("prospect@example.com");
    // No chrome and no why: the customer's reply quotes this message to their prospect.
    expect(body.htmlBody).toBe("<p>Hi, answer them.</p>");
    expect(body.textBody).toBe("Hi, answer them.");
    expect(JSON.stringify(body)).not.toContain("Revenue made easy.");
  });

  it("keeps a person-to-person template plain even when its layout is brand", async () => {
    mockSelectLimit.mockResolvedValueOnce([{ ...DB_TEMPLATE_ROW, htmlBody: "<p>Hi</p>", textBody: "Hi", stream: "transactional" }]);

    await send("positive-reply-answer-request");

    expect(wire().htmlBody).toBe("<p>Hi</p>");
    expect(wire().textBody).toBe("Hi");
    expect(wire().stream).toBe("transactional");
  });

  it("puts no stream on the wire for a broadcast template (today's delivery, byte for byte)", async () => {
    mockSelectLimit.mockResolvedValueOnce([{ ...DB_TEMPLATE_ROW, layout: "none", stream: "broadcast" }]);

    await send("reply-escalation");

    expect(wire()).not.toHaveProperty("stream");
  });

  it("does not wrap a staff-routed event", async () => {
    mockSelectLimit.mockResolvedValueOnce([{ ...DB_TEMPLATE_ROW, htmlBody: "<p>{{email}} changed a budget</p>" }]);

    await send("brand_daily_budget_changed", { recipientEmail: undefined, metadata: { email: "a@b.c" } });

    expect(wire().htmlBody).toBe("<p>a@b.c changed a budget</p>");
    expect(wire().textBody).toBe("Test");
  });

  it("does not wrap a template sent as another brand", async () => {
    mockSelectLimit.mockResolvedValueOnce([{ ...DB_TEMPLATE_ROW, fromAddress: "GrowthAgency.dev <hello@growthagency.dev>" }]);

    await send("contact_welcome");

    expect(wire().htmlBody).toBe("<p>Test</p>");
  });

  it("previews a bare template wrapped, exactly as it is sent", async () => {
    const res = await request(app)
      .post("/send/preview")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .send({ eventType: "credit-card-unusable" });

    expect(res.body.htmlBody).toBe(brandLayout("<p>Test</p>"));
    expect(res.body.textBody).toBe("Test\n\n--\ndistribute.you\nRevenue made easy.");
  });
});

describe("POST /send/preview", () => {
  it("returns the message a send would carry, signed, and sends nothing", async () => {
    mockSelectLimit.mockResolvedValueOnce([{ ...DB_TEMPLATE_ROW, subject: "Hi {{name}}", textBody: "Hello {{name}}" }]);

    const res = await request(app)
      .post("/send/preview")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .send({ eventType: "welcome", metadata: { name: "Ada" } });

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe("Hi Ada");
    expect(res.body.textBody).toBe("Hello Ada\n\n--\ndistribute.you\nRevenue made easy.");
    expect(res.body.htmlBody).toContain("Revenue made easy.");
    expect(res.body.from).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("previews a staff alert unsigned, as it is sent", async () => {
    const res = await request(app)
      .post("/send/preview")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .send({ eventType: "signup_notification" });

    expect(res.body.textBody).toBe("Test");
  });

  it("404s an event with no template", async () => {
    mockSelectLimit.mockResolvedValueOnce([]);
    const res = await request(app)
      .post("/send/preview")
      .set("X-API-Key", "test-service-key")
      .set("x-org-id", "org_456")
      .send({ eventType: "nope" });
    expect(res.status).toBe(404);
  });

  it("requires the API key", async () => {
    const res = await request(app).post("/send/preview").set("x-org-id", "org_456").send({ eventType: "welcome" });
    expect(res.status).toBe(401);
  });
});
