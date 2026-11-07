import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ sql: vi.fn(), db: {} }));

import {
  MAX_UNITS_PER_CALL,
  NEWSLETTER_EMAIL_SENT,
  planUnitCalls,
  unitLinkValue,
  UNIT_LINK_PARAM,
  type SentUnit,
} from "../../src/lib/newsletter-units.js";
import { stampOurLinks, SUBSCRIBER_LINK_PARAM } from "../../src/lib/subscriber-link.js";

const T1 = new Date("2026-11-02T08:00:00.000Z");
const T2 = new Date("2026-11-02T08:01:00.000Z");

const unit = (
  recipientId: string,
  releaseId: string,
  settledAt: Date,
  subscriberId: string | null = `sub-${recipientId}`,
  draftId: string | null = null
): SentUnit => ({
  recipientId,
  releaseId,
  subscriberId,
  draftId,
  settledAt,
});

describe("planUnitCalls", () => {
  it("states one newsletter_email_sent per email, consuming that subscriber's message_sent, one call per release x send instant", () => {
    const calls = planUnitCalls([unit("r2", "relA", T1), unit("r1", "relA", T1), unit("r3", "relA", T2), unit("r4", "relB", T1)]);
    expect(calls.map((c) => [c.releaseId, c.occurredAt, c.recipientIds])).toEqual([
      ["relA", T1.toISOString(), ["r1", "r2"]],
      ["relA", T2.toISOString(), ["r3"]],
      ["relB", T1.toISOString(), ["r4"]],
    ]);
    expect(calls[0].produced).toEqual([
      { outcomeKey: NEWSLETTER_EMAIL_SENT, subjectService: "transactional-email-service", subjectId: "r1" },
      { outcomeKey: NEWSLETTER_EMAIL_SENT, subjectService: "transactional-email-service", subjectId: "r2" },
    ]);
    expect(calls[0].consumed).toEqual([
      { outcomeKey: "message_sent", subjectService: "transactional-email-service", subjectId: "sub-r1" },
      { outcomeKey: "message_sent", subjectService: "transactional-email-service", subjectId: "sub-r2" },
    ]);
  });

  it("consumes nothing for an address no longer on the list (its send named nobody)", () => {
    const [call] = planUnitCalls([unit("r1", "relA", T1, null)]);
    expect(call.produced).toHaveLength(1);
    expect(call.consumed).toEqual([]);
  });

  it("consumes the release's newsletter_validated once per call when the release sends a draft (NEWSLETTER-OUTCOMES-1107)", () => {
    const calls = planUnitCalls([unit("r1", "relA", T1, "s1", "d1"), unit("r2", "relA", T1, "s2", "d1"), unit("r3", "relA", T2, null, "d1")]);
    expect(calls[0].consumed).toEqual([
      { outcomeKey: "newsletter_validated", subjectService: "transactional-email-service", subjectId: "d1" },
      { outcomeKey: "message_sent", subjectService: "transactional-email-service", subjectId: "s1" },
      { outcomeKey: "message_sent", subjectService: "transactional-email-service", subjectId: "s2" },
    ]);
    expect(calls[1].consumed).toEqual([{ outcomeKey: "newsletter_validated", subjectService: "transactional-email-service", subjectId: "d1" }]);
  });

  it("never states more than runs-service takes in one call", () => {
    const many = Array.from({ length: MAX_UNITS_PER_CALL * 2 + 1 }, (_, i) => unit(`r${String(i).padStart(5, "0")}`, "relA", T1));
    const calls = planUnitCalls(many);
    expect(calls.map((c) => c.recipientIds.length)).toEqual([MAX_UNITS_PER_CALL, MAX_UNITS_PER_CALL, 1]);
    for (const c of calls) expect(c.produced.length + c.consumed.length).toBeLessThanOrEqual(1000);
    const drafted = planUnitCalls(many.map((u) => ({ ...u, draftId: "d1" })));
    for (const c of drafted) expect(c.produced.length + c.consumed.length).toBeLessThanOrEqual(1000);
  });
});

describe("dy_unit on our links", () => {
  it("names the Unit beside dy_sub on our links only, authored bytes kept", () => {
    const value = unitLinkValue("8c1f0b7e-2f43-4c3e-9a51-6f7b1f2d9e10");
    expect(value).toBe("newsletter_email_sent:transactional-email-service:8c1f0b7e-2f43-4c3e-9a51-6f7b1f2d9e10");
    const out = stampOurLinks(
      {
        htmlBody: '<a href="https://distribute.you/blog/x?utm_source=newsletter&amp;utm_medium=email#top">x</a> <a href="https://example.com/p">p</a>',
        textBody: "Read https://distribute.you/blog/x. Or https://example.com/p",
      },
      [
        [SUBSCRIBER_LINK_PARAM, "LINKID"],
        [UNIT_LINK_PARAM, value],
      ]
    );
    expect(out.htmlBody).toContain(
      `href="https://distribute.you/blog/x?utm_source=newsletter&amp;utm_medium=email&amp;dy_sub=LINKID&amp;dy_unit=${value}#top"`
    );
    expect(out.htmlBody).toContain('href="https://example.com/p"');
    expect(out.textBody).toBe(`Read https://distribute.you/blog/x?dy_sub=LINKID&dy_unit=${value}. Or https://example.com/p`);
  });

  it("stamps nothing when given no parameter", () => {
    const body = { htmlBody: '<a href="https://distribute.you/">x</a>', textBody: "https://distribute.you/" };
    expect(stampOurLinks(body, [])).toBe(body);
  });
});
