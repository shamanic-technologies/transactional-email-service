import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailEvents } from "../db/schema.js";

/**
 * Moving a brand from one org to another, WITH ITS HISTORY — this service's half
 * of the fleet contract `POST /internal/transfer-brand`.
 *
 * What this service holds, and how each table relates to a brand:
 *
 *   email_events                     org_id + brand_ids, or a campaign   moved, brand rewritten
 *   mailing_lists / _subscribers     platform-level, no org, no brand    not a brand's row
 *   mailing_list_updates             platform-level, no org, no brand    not a brand's row
 *   mailing_list_releases            org_id is the SENDING identity of a
 *                                    staff broadcast; brand_ids is never
 *                                    set in production                   not a brand's row
 *   mailing_list_release_recipients  follows its release                 not a brand's row
 *   email_templates                  global                              not a brand's row
 *
 * An email_events row is "of this brand" when it sits under the source org and:
 *   - its `brand_ids` is the source brand alone, or
 *   - it carries no `brand_ids` and its `metadata.brandId` is the source brand
 *     (brand_daily_budget_changed records the brand there only), or
 *   - it carries no `brand_ids` and its `campaign_id` / `metadata.campaignId` is
 *     one of the brand's campaigns (campaign_created, campaign_stopped and
 *     campaign-error record the campaign only). The campaign ids come from
 *     campaign-service, which owns that mapping.
 * A co-branded row (two or more brands) belongs to another brand too, so it is
 * never moved; it is counted and logged.
 *
 * On each moved row, every place the source org is written moves with it:
 * `org_id`, `metadata.orgId`, and the `<orgId>:` prefix of `dedup_key` — so a
 * once-only or monthly event already sent for this brand is still deduplicated
 * under the new org instead of being sent twice.
 *
 * With a target brand, the brand id is rewritten (`brand_ids`, `metadata.brandId`,
 * `dedup_key`) only on rows under the TARGET org. A brand is a shared global
 * identity — two orgs can claim the same one — so a rewrite that ignored the org
 * would re-brand another org's history.
 *
 * Nothing about money is touched: this service holds none.
 *
 * One transaction; idempotent — a second call finds nothing of the brand under
 * the source org, and nothing of the source brand under the target org, and
 * reports zero.
 */

export interface BrandTransferInput {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
  /** The brand's own (solo-brand) campaigns, in either org. */
  campaignIds: string[];
}

export interface BrandTransferResult {
  updatedTables: Array<{ tableName: string; count: number }>;
  coBrandedSkipped: number;
}

const noBrandColumn = sql`coalesce(cardinality(${emailEvents.brandIds}), 0) = 0`;

/** The row names this brand and no other. */
function ofBrand(brandId: string, campaignIds: string[]): SQL {
  const byCampaign = campaignIds.length > 0
    ? [inArray(emailEvents.campaignId, campaignIds), sql`${emailEvents.metadata}->>'campaignId' IN ${campaignIds}`]
    : [];
  return or(
    sql`${emailEvents.brandIds} = ARRAY[${brandId}]::text[]`,
    and(noBrandColumn, or(sql`${emailEvents.metadata}->>'brandId' = ${brandId}`, ...byCampaign)),
  )!;
}

/** Rewrite every mention of `from` to `to` on the row — the brand or the org. */
function rewriteBrand(from: string, to: string) {
  return {
    brandIds: sql`CASE WHEN ${emailEvents.brandIds} = ARRAY[${from}]::text[] THEN ARRAY[${to}]::text[] ELSE ${emailEvents.brandIds} END`,
    metadata: sql`CASE WHEN ${emailEvents.metadata}->>'brandId' = ${from}
      THEN jsonb_set(${emailEvents.metadata}, '{brandId}', to_jsonb(${to}::text)) ELSE ${emailEvents.metadata} END`,
    dedupKey: sql`replace(${emailEvents.dedupKey}, ${from}, ${to})`,
  };
}

export async function transferBrand(input: BrandTransferInput): Promise<BrandTransferResult> {
  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId, campaignIds } = input;

  return db.transaction(async (tx) => {
    // 1. Move the brand's rows to the target org.
    const moved = await tx
      .update(emailEvents)
      .set({
        orgId: targetOrgId,
        metadata: sql`CASE WHEN ${emailEvents.metadata}->>'orgId' = ${sourceOrgId}
          THEN jsonb_set(${emailEvents.metadata}, '{orgId}', to_jsonb(${targetOrgId}::text)) ELSE ${emailEvents.metadata} END`,
        dedupKey: sql`CASE WHEN starts_with(${emailEvents.dedupKey}, ${sourceOrgId + ":"})
          THEN ${targetOrgId} || substr(${emailEvents.dedupKey}, ${sourceOrgId.length + 1}) ELSE ${emailEvents.dedupKey} END`,
      })
      .where(and(eq(emailEvents.orgId, sourceOrgId), ofBrand(sourceBrandId, campaignIds)))
      .returning({ id: emailEvents.id });

    // 2. Re-brand them — only under the target org.
    let rebranded: { id: string }[] = [];
    if (targetBrandId && targetBrandId !== sourceBrandId) {
      rebranded = await tx
        .update(emailEvents)
        .set(rewriteBrand(sourceBrandId, targetBrandId))
        .where(and(
          eq(emailEvents.orgId, targetOrgId),
          or(
            sql`${emailEvents.brandIds} = ARRAY[${sourceBrandId}]::text[]`,
            and(noBrandColumn, sql`${emailEvents.metadata}->>'brandId' = ${sourceBrandId}`),
          ),
        ))
        .returning({ id: emailEvents.id });
    }

    const [{ count: coBrandedSkipped }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(emailEvents)
      .where(and(
        eq(emailEvents.orgId, sourceOrgId),
        sql`${emailEvents.brandIds} @> ARRAY[${sourceBrandId}]::text[]`,
        sql`cardinality(${emailEvents.brandIds}) > 1`,
      ));

    const touched = new Set([...moved, ...rebranded].map((r) => r.id));
    return {
      updatedTables: [{ tableName: "email_events", count: touched.size }],
      coBrandedSkipped,
    };
  });
}
