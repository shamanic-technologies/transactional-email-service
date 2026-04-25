import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-service-key";
});

// Mock db
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockWhere = vi.fn();
const mockReturning = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    update: (...args: unknown[]) => {
      mockUpdate(...args);
      return {
        set: (...a: unknown[]) => {
          mockSet(...a);
          return {
            where: (...w: unknown[]) => {
              mockWhere(...w);
              return {
                returning: (...r: unknown[]) => {
                  mockReturning(...r);
                  return Promise.resolve(mockReturning._returnValue ?? []);
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
import transferBrandRoutes from "../../src/routes/transfer-brand.js";

const app = express();
app.use(express.json());
app.use(transferBrandRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mockReturning._returnValue = [];
});

const VALID_BODY = {
  sourceBrandId: "11111111-1111-4111-a111-111111111111",
  sourceOrgId: "22222222-2222-4222-a222-222222222222",
  targetOrgId: "33333333-3333-4333-a333-333333333333",
};

describe("POST /internal/transfer-brand", () => {
  it("returns 401 without api key", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send(VALID_BODY);

    expect(res.status).toBe(401);
  });

  it("returns 400 with invalid body (missing fields)", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send({ sourceBrandId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 400 with non-uuid values", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send({ sourceBrandId: "abc", sourceOrgId: "def", targetOrgId: "ghi" });

    expect(res.status).toBe(400);
  });

  it("updates matching rows and returns count", async () => {
    mockReturning._returnValue = [
      { id: "aaa" },
      { id: "bbb" },
      { id: "ccc" },
    ];

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send(VALID_BODY);

    expect(res.body).toEqual({
      updatedTables: [{ tableName: "email_events", count: 3 }],
    });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith({ orgId: VALID_BODY.targetOrgId });
  });

  it("rewrites brand_ids when targetBrandId is provided", async () => {
    mockReturning._returnValue = [{ id: "aaa" }, { id: "bbb" }];

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send({
        ...VALID_BODY,
        targetBrandId: "44444444-4444-4444-a444-444444444444",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updatedTables: [{ tableName: "email_events", count: 2 }],
    });
    expect(mockSet).toHaveBeenCalledWith({
      orgId: VALID_BODY.targetOrgId,
      brandIds: ["44444444-4444-4444-a444-444444444444"],
    });
  });

  it("returns count 0 when no rows match (idempotent)", async () => {
    mockReturning._returnValue = [];

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updatedTables: [{ tableName: "email_events", count: 0 }],
    });
  });

  it("does not require org identity headers (internal endpoint)", async () => {
    mockReturning._returnValue = [];

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send(VALID_BODY);

    // No x-org-id, x-user-id, x-run-id needed — should still succeed
    expect(res.status).toBe(200);
  });
});
