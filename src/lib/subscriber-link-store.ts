import { eq, sql as raw } from "drizzle-orm";
import { db } from "../db/index.js";
import { mailingListSubscriberLinks, mailingListSubscribers, mailingLists } from "../db/schema.js";
import { isWellFormedLinkId, mintLinkId } from "./subscriber-link.js";

/**
 * The stored half of `subscriber-link.ts`: minting each subscriber's link id
 * once, and answering who an id names. Own module because the route unit tests
 * fake the database, and the pure stamping must stay importable without it.
 */

/**
 * Each subscriber's link id, minted on first need and reused forever after.
 * A subscriber no longer on its list gets none (absent from the map): the
 * message still goes, with its links as written, exactly like the cost ledger
 * names nobody for it.
 */
export async function ensureLinkIds(subscriberIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(subscriberIds)];
  if (ids.length === 0) return new Map();

  // One statement per slice: candidates travel as ONE json parameter, the join
  // keeps only subscribers still listed, and the final SELECT returns the ids
  // inserted now plus those minted on an earlier send (a CTE's insert is not
  // visible to the outer read, so the two halves never overlap).
  const candidates = JSON.stringify(ids.map((subscriberId) => ({ link_id: mintLinkId(), subscriber_id: subscriberId })));
  const rows = await db.execute(raw`
    WITH v AS (
      SELECT * FROM json_to_recordset(${candidates}::json) AS v(link_id text, subscriber_id uuid)
    ), ins AS (
      INSERT INTO mailing_list_subscriber_links (link_id, list_id, subscriber_id)
      SELECT v.link_id, s.list_id, s.id FROM v JOIN mailing_list_subscribers s ON s.id = v.subscriber_id
      ON CONFLICT (subscriber_id) DO NOTHING
      RETURNING link_id, subscriber_id
    )
    SELECT link_id, subscriber_id FROM ins
    UNION ALL
    SELECT l.link_id, l.subscriber_id FROM mailing_list_subscriber_links l JOIN v ON v.subscriber_id = l.subscriber_id
  `);

  return new Map(
    (rows as unknown as Array<{ link_id: string; subscriber_id: string }>).map((r) => [r.subscriber_id, r.link_id])
  );
}

export type LinkResolution =
  | { status: "valid"; linkId: string; subscriber: { id: string; email: string; name: string | null }; list: { slug: string } }
  | { status: "revoked"; linkId: string }
  | { status: "unknown"; linkId: string }
  | { status: "tampered"; linkId: string };

export async function resolveLinkId(linkId: string): Promise<LinkResolution> {
  if (!isWellFormedLinkId(linkId)) return { status: "tampered", linkId };

  const [row] = await db
    .select({
      subscriberId: mailingListSubscriberLinks.subscriberId,
      email: mailingListSubscribers.email,
      slug: mailingLists.slug,
    })
    .from(mailingListSubscriberLinks)
    .innerJoin(mailingLists, eq(mailingLists.id, mailingListSubscriberLinks.listId))
    .leftJoin(mailingListSubscribers, eq(mailingListSubscribers.id, mailingListSubscriberLinks.subscriberId))
    .where(eq(mailingListSubscriberLinks.linkId, linkId))
    .limit(1);

  if (!row) return { status: "unknown", linkId };
  if (!row.subscriberId || !row.email) return { status: "revoked", linkId };

  return {
    status: "valid",
    linkId,
    // A list stores bare addresses: there is no name to give yet.
    subscriber: { id: row.subscriberId, email: row.email, name: null },
    list: { slug: row.slug },
  };
}
