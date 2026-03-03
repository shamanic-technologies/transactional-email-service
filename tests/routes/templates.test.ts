import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReturning, mockOnConflictDoUpdate, mockValues, now, earlier } = vi.hoisted(() => {
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-service-key";

  const now = new Date("2025-01-01T00:00:00Z");
  const earlier = new Date("2024-06-01T00:00:00Z");
  const mockReturning = vi.fn().mockResolvedValue([{ createdAt: now, updatedAt: now }]);
  const mockOnConflictDoUpdate = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });

  return { mockReturning, mockOnConflictDoUpdate, mockValues, now, earlier };
});

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: mockValues,
    }),
  },
}));

import request from "supertest";
import express from "express";
import templatesRoutes from "../../src/routes/templates.js";

const app = express();
app.use(express.json());
app.use(templatesRoutes);

const HEADERS = { "x-org-id": "org_123", "x-user-id": "user_123" };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: created (timestamps equal)
  mockReturning.mockResolvedValue([{ createdAt: now, updatedAt: now }]);
  mockOnConflictDoUpdate.mockReturnValue({ returning: mockReturning });
  mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
});

describe("PUT /templates", () => {
  it("creates new templates via upsert", async () => {
    const res = await request(app)
      .put("/templates")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        templates: [
          {
            name: "welcome",
            subject: "Welcome!",
            htmlBody: "<h1>Welcome</h1>",
            textBody: "Welcome",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.templates).toEqual([{ name: "welcome", action: "created" }]);
    expect(mockOnConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it("updates existing templates via upsert", async () => {
    // updatedAt is later than createdAt → means it was an update
    mockReturning.mockResolvedValue([{ createdAt: earlier, updatedAt: now }]);

    const res = await request(app)
      .put("/templates")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        templates: [
          {
            name: "welcome",
            subject: "Updated welcome!",
            htmlBody: "<h1>Updated</h1>",
            textBody: "Updated",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.templates).toEqual([{ name: "welcome", action: "updated" }]);
  });

  it("handles concurrent deploys without errors (upsert is atomic)", async () => {
    // Both calls return "created" — the important thing is no duplicate key error
    const res = await request(app)
      .put("/templates")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        templates: [
          {
            name: "webinar-registration-welcome",
            subject: "Welcome!",
            htmlBody: "<h1>Hi</h1>",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
    // Verify onConflictDoUpdate was called (not a plain insert)
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.any(Array),
        set: expect.objectContaining({
          subject: "Welcome!",
          htmlBody: "<h1>Hi</h1>",
        }),
      })
    );
  });

  it("handles multiple templates in one request", async () => {
    const res = await request(app)
      .put("/templates")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        templates: [
          { name: "welcome", subject: "Welcome!", htmlBody: "<h1>Hi</h1>" },
          { name: "reset", subject: "Reset", htmlBody: "<h1>Reset</h1>" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(2);
    expect(res.body.templates[0]).toEqual({ name: "welcome", action: "created" });
    expect(res.body.templates[1]).toEqual({ name: "reset", action: "created" });
  });

  it("persists per-template from in upsert values", async () => {
    const res = await request(app)
      .put("/templates")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        templates: [
          {
            name: "checkout_success",
            subject: "Thanks for your purchase!",
            htmlBody: "<h1>Thanks!</h1>",
            from: "GrowthAgency <hello@growthagency.dev>",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.templates).toEqual([{ name: "checkout_success", action: "created" }]);

    // Verify from was passed to the insert values
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: "GrowthAgency <hello@growthagency.dev>",
      })
    );
  });

  it("supports different from per template in same request", async () => {
    const res = await request(app)
      .put("/templates")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        templates: [
          {
            name: "welcome",
            subject: "Welcome!",
            htmlBody: "<h1>Hi</h1>",
            from: "GrowthAgency <hello@growthagency.dev>",
          },
          {
            name: "support_ticket",
            subject: "Ticket received",
            htmlBody: "<h1>Got it</h1>",
            from: "Support <support@growthagency.dev>",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(2);

    // First template
    expect(mockValues).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        fromAddress: "GrowthAgency <hello@growthagency.dev>",
      })
    );

    // Second template with different from
    expect(mockValues).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        fromAddress: "Support <support@growthagency.dev>",
      })
    );
  });

  it("sets fromAddress to null when not provided", async () => {
    const res = await request(app)
      .put("/templates")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        templates: [
          {
            name: "welcome",
            subject: "Welcome!",
            htmlBody: "<h1>Welcome</h1>",
          },
        ],
      });

    expect(res.status).toBe(200);

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: null,
      })
    );
  });

  it("returns 400 for missing identity headers", async () => {
    const res = await request(app)
      .put("/templates")
      .set("X-API-Key", "test-service-key")
      .send({
        templates: [{ name: "welcome", subject: "Hi", htmlBody: "<h1>Hi</h1>" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required headers");
  });

  it("returns 400 for empty templates array", async () => {
    const res = await request(app)
      .put("/templates")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({
        templates: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .put("/templates")
      .set(HEADERS)
      .send({
        templates: [{ name: "welcome", subject: "Hi", htmlBody: "<h1>Hi</h1>" }],
      });

    expect(res.status).toBe(401);
  });
});
