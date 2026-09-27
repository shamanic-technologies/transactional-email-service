/**
 * HTTP client for campaign-service — used only by the brand transfer, to learn
 * which campaigns belong to a brand.
 *
 * Many email_events rows (campaign_created, campaign_stopped, campaign-error)
 * carry a campaign id and no brand id at all, so the campaign is the only thing
 * tying them to a brand. This service stores no campaign → brand mapping of its
 * own; campaign-service owns it.
 */

interface CampaignRow {
  id: string;
  brandId?: string | null;
  brandIds?: string[] | null;
}

function config(): { url: string; apiKey: string } {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("CAMPAIGN_SERVICE_URL and CAMPAIGN_SERVICE_API_KEY must be set to transfer a brand");
  }
  return { url, apiKey };
}

/**
 * Ids of the campaigns of `orgId` whose brand is `brandId` ALONE. A co-branded
 * campaign belongs to another brand too — campaign-service never moves one, so
 * neither do we.
 */
export async function listSoloBrandCampaignIds(orgId: string, brandId: string): Promise<string[]> {
  const { url, apiKey } = config();
  const path = `/campaigns?brandId=${encodeURIComponent(brandId)}`;
  const response = await fetch(`${url}${path}`, {
    method: "GET",
    headers: { "X-API-Key": apiKey, "x-org-id": orgId },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`campaign-service GET ${path} failed: ${response.status} - ${errorText}`);
  }

  const body = (await response.json()) as { campaigns: CampaignRow[] };
  return body.campaigns
    .filter((c) => {
      const ids = c.brandIds ?? [];
      if (ids.length > 1) return false;
      return ids.length === 1 ? ids[0] === brandId : c.brandId === brandId;
    })
    .map((c) => c.id);
}
