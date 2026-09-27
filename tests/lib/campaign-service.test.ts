import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listSoloBrandCampaignIds } from "../../src/lib/campaign-service.js";

const BRAND = "b1";

beforeEach(() => {
  process.env.CAMPAIGN_SERVICE_URL = "http://campaign";
  process.env.CAMPAIGN_SERVICE_API_KEY = "ck";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listSoloBrandCampaignIds", () => {
  it("keeps only campaigns whose brand is this brand alone", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ campaigns: [
        { id: "solo-ids", brandId: BRAND, brandIds: [BRAND] },
        { id: "solo-legacy", brandId: BRAND, brandIds: null },
        { id: "co-branded", brandId: BRAND, brandIds: [BRAND, "b2"] },
        { id: "other", brandId: "b2", brandIds: ["b2"] },
      ] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await listSoloBrandCampaignIds("org1", BRAND)).toEqual(["solo-ids", "solo-legacy"]);
    expect(fetchMock).toHaveBeenCalledWith("http://campaign/campaigns?brandId=b1", {
      method: "GET",
      headers: { "X-API-Key": "ck", "x-org-id": "org1" },
    });
  });

  it("throws on a non-2xx answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "bad" }));
    await expect(listSoloBrandCampaignIds("org1", BRAND)).rejects.toThrow("502");
  });

  it("throws when not configured", async () => {
    delete process.env.CAMPAIGN_SERVICE_API_KEY;
    await expect(listSoloBrandCampaignIds("org1", BRAND)).rejects.toThrow("CAMPAIGN_SERVICE_API_KEY");
  });
});
