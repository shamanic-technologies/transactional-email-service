/**
 * Every release runs under a campaign (NEWSLETTER-CAMPAIGN-1108).
 *
 * Owner 2026-11-08: every dollar a release spends (address verification at
 * apollo-service, the send at postmark-service) must land on a campaign of the
 * brand it is sent for, so it shows on that campaign's dashboard and is held by
 * that campaign's budget. A release stamps its campaign on its own run and on
 * every downstream call (`x-campaign-id`), so the campaign it is created with is
 * the campaign everything it spends is booked on, for days.
 *
 * So a release that names no campaign is REFUSED, loudly, before anything is
 * written: measured 2026-11-08, $55 of verification in 30 days sat on no
 * campaign because releases were launched with none. There is no default
 * campaign and no lookup by brand: which campaign pays is the caller's
 * statement, the same as for every other spend in the fleet.
 *
 * The named campaign is read from campaign-service under the release's org: a
 * campaign that org does not hold is refused too (a typo would otherwise book a
 * week of spend on a campaign nobody can see). A release that names no brand
 * takes its campaign's brands, so its Units chart per brand as well.
 *
 * Own module: the release tests mock it whole, as they mock every other service
 * this route calls.
 */

export class ReleaseCampaignRefusal extends Error {
  constructor(
    readonly reason: "campaign_required" | "campaign_not_found",
    message: string
  ) {
    super(message);
    this.name = "ReleaseCampaignRefusal";
  }
}

export interface ReleaseCampaign {
  campaignId: string;
  /** The brands the release is sent for: the caller's own, else the campaign's. */
  brandIds: string[] | undefined;
}

interface CampaignRow {
  id: string;
  brandId?: string | null;
  brandIds?: string[] | null;
}

function config(): { url: string; apiKey: string } {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("CAMPAIGN_SERVICE_URL and CAMPAIGN_SERVICE_API_KEY must be set to start a release");
  }
  return { url, apiKey };
}

export async function resolveReleaseCampaign(input: {
  orgId: string;
  campaignId: string | undefined;
  brandIds: string[] | undefined;
}): Promise<ReleaseCampaign> {
  const campaignId = input.campaignId?.trim();
  if (!campaignId) {
    throw new ReleaseCampaignRefusal(
      "campaign_required",
      "A release must name the campaign it runs under (header x-campaign-id): everything it spends, " +
        "address checks and sends, is booked on that campaign and held by its budget. " +
        "For distribute.you's newsletter, that is the newsletter campaign of the Distribute.you brand."
    );
  }

  const { url, apiKey } = config();
  const path = `/campaigns/${encodeURIComponent(campaignId)}`;
  const response = await fetch(`${url}${path}`, {
    method: "GET",
    headers: { "X-API-Key": apiKey, "x-org-id": input.orgId },
  });
  if (response.status === 404) {
    throw new ReleaseCampaignRefusal(
      "campaign_not_found",
      `Campaign ${campaignId} is not a campaign of organization ${input.orgId}. Name one of its own campaigns in x-campaign-id.`
    );
  }
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`campaign-service GET ${path} failed: ${response.status} - ${errorText}`);
  }

  const { campaign } = (await response.json()) as { campaign: CampaignRow };
  const campaignBrands = campaign.brandIds?.length ? campaign.brandIds : campaign.brandId ? [campaign.brandId] : [];
  const brandIds = input.brandIds?.length ? input.brandIds : campaignBrands.length ? campaignBrands : undefined;
  return { campaignId, brandIds };
}
