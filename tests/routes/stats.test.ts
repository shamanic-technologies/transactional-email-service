import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-service-key";
});

// Mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockGroupBy = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return {
        from: (...a: unknown[]) => {
          mockFrom(...a);
          return {
            where: (...w: unknown[]) => {
              mockWhere(...w);
              return {
                groupBy: (...g: unknown[]) => {
                  mockGroupBy(...g);
                  return Promise.resolve([
                    { status: "sent", count: 10 },
                    { status: "failed", count: 2 },
                  ]);
                },
              };
            },
          };
        },
      };
    },
  },
}));

import request from "supertest";
import express from "express";
import statsRoutes from "../../src/routes/stats.js";

const app = express();
app.use(express.json());
app.use(statsRoutes);

const HEADERS = { "x-org-id": "org_123", "x-user-id": "user_123", "x-run-id": "run_001" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /stats", () => {
  it("returns 401 without api key", async () => {
    const res = await request(app)
      .post("/stats")
      .set(HEADERS)
      .send({});

    expect(res.status).toBe(401);
  });

  it("returns 400 when identity headers are missing", async () => {
    const res = await request(app)
      .post("/stats")
      .set("X-API-Key", "test-service-key")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required headers");
  });

  it("returns aggregated stats scoped by org from headers", async () => {
    const res = await request(app)
      .post("/stats")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({
      totalEmails: 12,
      sent: 10,
      failed: 2,
      pending: 0,
    });
  });

  it("returns stats filtered by eventType", async () => {
    const res = await request(app)
      .post("/stats")
      .set("X-API-Key", "test-service-key")
      .set(HEADERS)
      .send({ eventType: "welcome" });

    expect(res.status).toBe(200);
    expect(res.body.stats).toBeDefined();
  });
});
