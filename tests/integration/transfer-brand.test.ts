import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { emailEvents, mailingLists, mailingListReleases } from "../../src/db/schema.js";
import { transferBrand } from "../../src/lib/brand-transfer.js";

const SRC_ORG = "11111111-1111-4111-a111-111111111111";
const TGT_ORG = "22222222-2222-4222-a222-222222222222";
const OTHER_ORG = "99999999-9999-4999-a999-999999999999";
const BRAND = "33333333-3333-4333-a333-333333333333";
const NEW_BRAND = "44444444-4444-4444-a444-444444444444";
const OTHER_BRAND = "55555555-5555-4555-a555-555555555555";
const CAMPAIGN = "66666666-6666-4666-a666-666666666666";
const OTHER_CAMPAIGN = "77777777-7777-4777-a777-777777777777";

type Row = typeof emailEvents.$inferInsert;
const base = { recipientEmail: "a@x.com", status: "sent" };

// One row per way this service ties a row to a brand, plus the rows that must NOT move.
const ROWS: Record<string, Row> = {
  brandColumn: { ...base, eventType: "audience_fully_contacted", orgId: SRC_ORG, brandIds: [BRAND],
    dedupKey: `${SRC_ORG}:audience_fully_contacted:${BRAND}:2026-09`, metadata: { orgId: SRC_ORG, brandId: BRAND } },
  metadataBrand: { ...base, eventType: "brand_daily_budget_changed", orgId: SRC_ORG, metadata: { orgId: SRC_ORG, brandId: BRAND, newBudget: 10 } },
  campaignColumn: { ...base, eventType: "campaign_created", orgId: SRC_ORG, campaignId: CAMPAIGN, metadata: { campaignName: "C" } },
  metadataCampaign: { ...base, eventType: "campaign-error", orgId: SRC_ORG, metadata: { campaignId: CAMPAIGN } },
  // Must stay put:
  otherBrand: { ...base, eventType: "campaign_created", orgId: SRC_ORG, brandIds: [OTHER_BRAND], campaignId: CAMPAIGN },
  coBranded: { ...base, eventType: "campaign_created", orgId: SRC_ORG, brandIds: [BRAND, OTHER_BRAND] },
  otherCampaign: { ...base, eventType: "campaign_created", orgId: SRC_ORG, campaignId: OTHER_CAMPAIGN },
  orgLevel: { ...base, eventType: "welcome", orgId: SRC_ORG, dedupKey: `${SRC_ORG}:welcome:user_1` },
  sameBrandOtherOrg: { ...base, eventType: "campaign_created", orgId: OTHER_ORG, brandIds: [BRAND] },
};

const ids: Record<string, string> = {};

async function row(name: string) {
  const [r] = await db.select().from(emailEvents).where(eq(emailEvents.id, ids[name]));
  return r;
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
}, 15000);

beforeEach(async () => {
  await sql`TRUNCATE TABLE email_events, mailing_lists CASCADE`;
  for (const [name, values] of Object.entries(ROWS)) {
    const [r] = await db.insert(emailEvents).values(values).returning({ id: emailEvents.id });
    ids[name] = r.id;
  }
});

afterAll(async () => {
  await sql.end();
});

const MOVED = ["brandColumn", "metadataBrand", "campaignColumn", "metadataCampaign"];
const KEPT = ["otherBrand", "coBranded", "otherCampaign", "orgLevel"];

describe("transferBrand (email_events)", () => {
  it("moves every row tied to the brand — by brand column, metadata brand, campaign column, metadata campaign", async () => {
    const result = await transferBrand({ sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG, campaignIds: [CAMPAIGN] });

    expect(result.updatedTables).toEqual([{ tableName: "email_events", count: 4 }]);
    expect(result.coBrandedSkipped).toBe(1);
    for (const name of MOVED) expect((await row(name)).orgId, name).toBe(TGT_ORG);
    for (const name of KEPT) expect((await row(name)).orgId, name).toBe(SRC_ORG);
    expect((await row("sameBrandOtherOrg")).orgId).toBe(OTHER_ORG);

    // Nothing of the brand is left under the source org except the co-branded row.
    const left = await db.select().from(emailEvents).where(eq(emailEvents.orgId, SRC_ORG));
    expect(left.map((r) => r.id).sort()).toEqual(KEPT.map((n) => ids[n]).sort());
  });

  it("carries the org id inside metadata and the dedup key along", async () => {
    await transferBrand({ sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG, campaignIds: [CAMPAIGN] });

    const r = await row("brandColumn");
    expect(r.dedupKey).toBe(`${TGT_ORG}:audience_fully_contacted:${BRAND}:2026-09`);
    expect(r.metadata).toEqual({ orgId: TGT_ORG, brandId: BRAND });
    expect((await row("metadataBrand")).metadata).toEqual({ orgId: TGT_ORG, brandId: BRAND, newBudget: 10 });
    // An org-level row is not the brand's: its key keeps the source org.
    expect((await row("orgLevel")).dedupKey).toBe(`${SRC_ORG}:welcome:user_1`);
  });

  it("rewrites the brand id only under the target org when a target brand is given", async () => {
    const result = await transferBrand({
      sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG, targetBrandId: NEW_BRAND, campaignIds: [CAMPAIGN],
    });

    expect(result.updatedTables).toEqual([{ tableName: "email_events", count: 4 }]);
    const r = await row("brandColumn");
    expect(r.brandIds).toEqual([NEW_BRAND]);
    expect(r.dedupKey).toBe(`${TGT_ORG}:audience_fully_contacted:${NEW_BRAND}:2026-09`);
    expect(r.metadata).toEqual({ orgId: TGT_ORG, brandId: NEW_BRAND });
    expect((await row("metadataBrand")).metadata).toEqual({ orgId: TGT_ORG, brandId: NEW_BRAND, newBudget: 10 });
    // Another org claiming the same brand keeps its brand id.
    expect((await row("sameBrandOtherOrg")).brandIds).toEqual([BRAND]);
  });

  it("is idempotent: a second call moves nothing and changes nothing", async () => {
    const input = { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG, targetBrandId: NEW_BRAND, campaignIds: [CAMPAIGN] };
    await transferBrand(input);
    const before = await db.select().from(emailEvents);

    const second = await transferBrand(input);

    expect(second.updatedTables).toEqual([{ tableName: "email_events", count: 0 }]);
    const after = await db.select().from(emailEvents);
    expect(after.sort((a, b) => a.id.localeCompare(b.id))).toEqual(before.sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("moves nothing by campaign when the brand has no campaigns", async () => {
    const result = await transferBrand({ sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG, campaignIds: [] });

    expect(result.updatedTables).toEqual([{ tableName: "email_events", count: 2 }]);
    expect((await row("campaignColumn")).orgId).toBe(SRC_ORG);
  });

  it("leaves mailing-list releases alone — their org is a staff broadcast's sending identity", async () => {
    const [list] = await db.insert(mailingLists).values({ slug: "investors" }).returning();
    const [release] = await db.insert(mailingListReleases).values({
      listId: list.id, subject: "s", fromAddress: "a@x.com", bodyKind: "html", htmlBody: "<p/>", textBody: "t",
      dedupKey: "k", dailyLimit: 10, status: "running", recipientCount: 0, orgId: SRC_ORG, userId: "u",
      runId: "88888888-8888-4888-a888-888888888888",
    }).returning();

    await transferBrand({ sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG, campaignIds: [CAMPAIGN] });

    const [after] = await db.select().from(mailingListReleases).where(eq(mailingListReleases.id, release.id));
    expect(after.orgId).toBe(SRC_ORG);
  });
});
