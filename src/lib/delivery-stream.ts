// How email-gateway delivers one transactional email. "broadcast" is every send
// today: the Postmark broadcast stream (List-Unsubscribe header) plus the
// gateway's visible Unsubscribe footer. "transactional" is person-to-person mail
// a recipient answers like a normal email: the Postmark transactional stream,
// no List-Unsubscribe header, no footer. Never for a mailing list or anything a
// recipient can ask to stop receiving.
//
// Its own module, not email-gateway.ts: tests `vi.mock` the gateway client
// whole, and src/schemas.ts reads this list at import time.
export const DELIVERY_STREAMS = ["broadcast", "transactional"] as const;
export type DeliveryStream = (typeof DELIVERY_STREAMS)[number];
