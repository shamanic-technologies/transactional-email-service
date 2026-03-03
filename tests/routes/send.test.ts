import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockWhere,
  mockSet,
  mockUpdate,
  mockReturning,
  mockOnConflictDoNothing,
  mockValues,
  mockInsert,
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

  return { mockWhere, mockSet, mockUpdate, mockReturning, mockOnConflictDoNothing, mockValues, mockInsert };
});

// Mock db to avoid needing a real database
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: mockInsert,
    update: mockUpdate,
    // getTemplate now queries DB first; return empty to fall back to hardcoded templates
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
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

import request from "supertest";
import express from "express";
import sendRoutes from "../../src/routes/send.js";

let fetchSpy: ReturnType<typeof vi.fn>;

const app = express();
app.use(express.json());
app.use(sendRoutes);

// Identity headers applied to all requests
const HEADERS = { "x-org-id": "org_456", "x-user-id": "user_123" };

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
        brandId: "brand_abc",
        campaignId: "campaign_def",
      });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.type).toBe("transactional");
    expect(body.clerkOrgId).toBe("org_456");
    expect(body.runId).toBe("run-456");
    expect(body.to).toBeDefined();
    expect(body.subject).toBeDefined();
    expect(body.brandId).toBe("brand_abc");
    expect(body.campaignId).toBe("campaign_def");
  });

  it("returns 400 when x-org-id header is missing", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set("x-user-id", "user_123")
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

  it("succeeds without brandId/campaignId and omits them from request", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "user_active",
      });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.brandId).toBeUndefined();
    expect(body.campaignId).toBeUndefined();
  });

  it("passes brandId and campaignId for campaign events", async () => {
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        brandId: "brand_abc",
        campaignId: "campaign_def",
        recipientEmail: "user@example.com",
        metadata: { campaignName: "Test Campaign" },
      });

    expect(res.status).toBe(200);

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.brandId).toBe("brand_abc");
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

    // campaign_created is a repeatable (non-deduped) event
    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "campaign_created",
        recipientEmail: "user@example.com",
        metadata: { campaignName: "Test" },
      });

    expect(res.status).toBe(200);
    expect(res.body.results[0].sent).toBe(false);

    // Should still update the event to "failed" even without a dedup key
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });

  it("accepts parentRunId and forwards to run creation", async () => {
    const { createRun } = await import("../../src/lib/runs-client.js");

    const res = await request(app)
      .post("/send")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        eventType: "user_active",
        parentRunId: "parent-run-789",
      });

    expect(res.status).toBe(200);
    expect(vi.mocked(createRun)).toHaveBeenCalledWith(
      expect.objectContaining({ parentRunId: "parent-run-789" })
    );
  });
});
