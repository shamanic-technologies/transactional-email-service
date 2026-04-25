import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-service-key";
});

// Mock db — tracks each update chain call separately
const mockCalls: { set: unknown; where: unknown; returning: unknown; returnValue: unknown[] }[] = [];
let callIndex = 0;

vi.mock("../../src/db/index.js", () => ({
  db: {
    update: () => ({
      set: (...a: unknown[]) => {
        const idx = callIndex++;
        if (!mockCalls[idx]) mockCalls[idx] = { set: null, where: null, returning: null, returnValue: [] };
        mockCalls[idx].set = a[0];
        return {
          where: (...w: unknown[]) => {
            mockCalls[idx].where = w[0];
            return {
              returning: (...r: unknown[]) => {
                mockCalls[idx].returning = r[0];
                return Promise.resolve(mockCalls[idx].returnValue);
              },
            };
          },
        };
      },
    }),
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
  mockCalls.length = 0;
  callIndex = 0;
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

  it("moves matching rows and returns count (no targetBrandId)", async () => {
    mockCalls.push({ set: null, where: null, returning: null, returnValue: [{ id: "aaa" }, { id: "bbb" }, { id: "ccc" }] });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updatedTables: [{ tableName: "email_events", count: 3 }],
    });
    // Step 1 only: set org_id
    expect(mockCalls[0].set).toEqual({ orgId: VALID_BODY.targetOrgId });
    // No step 2
    expect(mockCalls).toHaveLength(1);
  });

  it("moves rows then rewrites brand_ids when targetBrandId is provided", async () => {
    // Step 1: move returns 2 rows
    mockCalls.push({ set: null, where: null, returning: null, returnValue: [{ id: "aaa" }, { id: "bbb" }] });
    // Step 2: rewrite returns 2 rows
    mockCalls.push({ set: null, where: null, returning: null, returnValue: [{ id: "aaa" }, { id: "bbb" }] });

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
    // Step 1: move org
    expect(mockCalls[0].set).toEqual({ orgId: VALID_BODY.targetOrgId });
    // Step 2: rewrite brand (no org filter)
    expect(mockCalls[1].set).toEqual({ brandIds: ["44444444-4444-4444-a444-444444444444"] });
    expect(mockCalls).toHaveLength(2);
  });

  it("returns count 0 when no rows match (idempotent)", async () => {
    mockCalls.push({ set: null, where: null, returning: null, returnValue: [] });

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
    mockCalls.push({ set: null, where: null, returning: null, returnValue: [] });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send(VALID_BODY);

    // No x-org-id, x-user-id, x-run-id needed — should still succeed
    expect(res.status).toBe(200);
  });
});
