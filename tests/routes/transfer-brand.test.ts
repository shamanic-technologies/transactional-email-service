import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-service-key";
});

vi.mock("../../src/lib/brand-transfer.js", () => ({
  transferBrand: vi.fn(),
}));
vi.mock("../../src/lib/campaign-service.js", () => ({
  listSoloBrandCampaignIds: vi.fn(),
}));

import request from "supertest";
import express from "express";
import transferBrandRoutes from "../../src/routes/transfer-brand.js";
import { transferBrand } from "../../src/lib/brand-transfer.js";
import { listSoloBrandCampaignIds } from "../../src/lib/campaign-service.js";

const app = express();
app.use(express.json());
app.use(transferBrandRoutes);

const VALID_BODY = {
  sourceBrandId: "11111111-1111-4111-a111-111111111111",
  sourceOrgId: "22222222-2222-4222-a222-222222222222",
  targetOrgId: "33333333-3333-4333-a333-333333333333",
};
const TARGET_BRAND = "44444444-4444-4444-a444-444444444444";

beforeEach(() => {
  vi.mocked(transferBrand).mockReset().mockResolvedValue({
    updatedTables: [{ tableName: "email_events", count: 3 }],
    coBrandedSkipped: 0,
  });
  vi.mocked(listSoloBrandCampaignIds).mockReset().mockImplementation(async (orgId: string) =>
    orgId === VALID_BODY.sourceOrgId ? ["c1", "c2"] : ["c2", "c3"]);
});

describe("POST /internal/transfer-brand", () => {
  it("returns 401 without api key", async () => {
    const res = await request(app).post("/internal/transfer-brand").send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it("returns 400 with invalid body", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send({ sourceBrandId: "abc", sourceOrgId: "def", targetOrgId: "ghi" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(transferBrand).not.toHaveBeenCalled();
  });

  it("resolves the brand's campaigns in both orgs and transfers with their union", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updatedTables: [{ tableName: "email_events", count: 3 }] });
    expect(vi.mocked(listSoloBrandCampaignIds).mock.calls).toEqual([
      [VALID_BODY.sourceOrgId, VALID_BODY.sourceBrandId],
      [VALID_BODY.targetOrgId, VALID_BODY.sourceBrandId],
    ]);
    expect(transferBrand).toHaveBeenCalledWith({ ...VALID_BODY, targetBrandId: undefined, campaignIds: ["c1", "c2", "c3"] });
  });

  it("also looks up the target brand's campaigns in the target org when a target brand is given", async () => {
    await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send({ ...VALID_BODY, targetBrandId: TARGET_BRAND });

    expect(vi.mocked(listSoloBrandCampaignIds).mock.calls).toContainEqual([VALID_BODY.targetOrgId, TARGET_BRAND]);
    expect(transferBrand).toHaveBeenCalledWith(expect.objectContaining({ targetBrandId: TARGET_BRAND }));
  });

  it("fails loud when campaign-service cannot answer — nothing is moved", async () => {
    vi.mocked(listSoloBrandCampaignIds).mockRejectedValueOnce(new Error("campaign-service GET /campaigns failed: 502"));

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(transferBrand).not.toHaveBeenCalled();
  });

  it("does not require org identity headers (internal endpoint)", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("X-API-Key", "test-service-key")
      .send(VALID_BODY);
    expect(res.status).toBe(200);
  });
});
