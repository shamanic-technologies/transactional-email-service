import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseCampaignRefusal, resolveReleaseCampaign } from "../../src/lib/release-campaign.js";

describe("resolveReleaseCampaign (NEWSLETTER-CAMPAIGN-1108)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.CAMPAIGN_SERVICE_URL = "http://campaign.test";
    process.env.CAMPAIGN_SERVICE_API_KEY = "k";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a release with no campaign without calling campaign-service", async () => {
    await expect(resolveReleaseCampaign({ orgId: "o", campaignId: undefined, brandIds: undefined })).rejects.toMatchObject({
      reason: "campaign_required",
    });
    await expect(resolveReleaseCampaign({ orgId: "o", campaignId: "  ", brandIds: undefined })).rejects.toBeInstanceOf(
      ReleaseCampaignRefusal
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a campaign the org does not hold", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Campaign not found" }), { status: 404 }));
    await expect(resolveReleaseCampaign({ orgId: "o", campaignId: "c", brandIds: undefined })).rejects.toMatchObject({
      reason: "campaign_not_found",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://campaign.test/campaigns/c");
    expect(init.headers["x-org-id"]).toBe("o");
  });

  it("fails loud when campaign-service is down: a 502, never a release on an unchecked campaign", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(resolveReleaseCampaign({ orgId: "o", campaignId: "c", brandIds: undefined })).rejects.not.toBeInstanceOf(
      ReleaseCampaignRefusal
    );
  });

  it("keeps the caller's brands, else takes the campaign's", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ campaign: { id: "c", brandIds: ["b1"] } }), { status: 200 }));
    expect(await resolveReleaseCampaign({ orgId: "o", campaignId: "c", brandIds: undefined })).toEqual({ campaignId: "c", brandIds: ["b1"] });
    expect(await resolveReleaseCampaign({ orgId: "o", campaignId: "c", brandIds: ["mine"] })).toEqual({ campaignId: "c", brandIds: ["mine"] });
  });
});
