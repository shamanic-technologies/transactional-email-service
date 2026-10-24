import { describe, it, expect } from "vitest";
import { isWellFormedLinkId, mintLinkId, stampSubscriberLinks, SUBSCRIBER_LINK_PARAM } from "../../src/lib/subscriber-link.js";

const ID = mintLinkId();

describe("link ids", () => {
  it("mints 26 url-safe characters that check as well formed, never twice the same", () => {
    expect(ID).toMatch(/^[A-Za-z0-9_-]{26}$/);
    expect(isWellFormedLinkId(ID)).toBe(true);
    expect(mintLinkId()).not.toBe(ID);
  });

  it("refuses an edited, truncated or foreign id", () => {
    const flipped = (ID[0] === "A" ? "B" : "A") + ID.slice(1);
    expect(isWellFormedLinkId(flipped)).toBe(false);
    expect(isWellFormedLinkId(ID.slice(0, 25))).toBe(false);
    expect(isWellFormedLinkId("ramy.lahoud.ext@cosmotech.com")).toBe(false);
    expect(isWellFormedLinkId("")).toBe(false);
  });
});

describe("stampSubscriberLinks", () => {
  it("stamps every distribute.you link (subdomains too) and leaves third-party links as written", () => {
    const htmlBody =
      '<a href="https://distribute.you/blog/jev-gtm?utm_source=newsletter&amp;utm_medium=email">Read</a>' +
      " <a href='https://dashboard.distribute.you/v2'>Open</a>" +
      ' <a href="https://example.com/?utm_source=newsletter&amp;x=1">Other</a>' +
      ' <a href="https://distribute.you.evil.com/x">Lookalike</a>' +
      ' <a href="mailto:kevin@distribute.you">Mail</a>' +
      " <p>https://distribute.you/visible stays as text</p>";
    const textBody = "Read: https://distribute.you/blog/jev-gtm?utm_campaign=jev-gtm. Other (https://example.com/a)";

    const out = stampSubscriberLinks({ htmlBody, textBody }, ID);

    expect(out.htmlBody).toContain(
      `href="https://distribute.you/blog/jev-gtm?utm_source=newsletter&amp;utm_medium=email&amp;${SUBSCRIBER_LINK_PARAM}=${ID}"`
    );
    expect(out.htmlBody).toContain(`href='https://dashboard.distribute.you/v2?${SUBSCRIBER_LINK_PARAM}=${ID}'`);
    expect(stampSubscriberLinks({ htmlBody: '<a href="https://distribute.you">x</a>', textBody: "" }, ID).htmlBody).toBe(
      `<a href="https://distribute.you?${SUBSCRIBER_LINK_PARAM}=${ID}">x</a>`
    );
    expect(out.htmlBody).toContain('href="https://example.com/?utm_source=newsletter&amp;x=1"');
    expect(out.htmlBody).toContain('href="https://distribute.you.evil.com/x"');
    expect(out.htmlBody).toContain('href="mailto:kevin@distribute.you"');
    expect(out.htmlBody).toContain("<p>https://distribute.you/visible stays as text</p>");

    expect(out.textBody).toBe(
      `Read: https://distribute.you/blog/jev-gtm?utm_campaign=jev-gtm&${SUBSCRIBER_LINK_PARAM}=${ID}. Other (https://example.com/a)`
    );
  });

  it("puts the parameter before a fragment and replaces one already there", () => {
    expect(stampSubscriberLinks({ htmlBody: '<a href="https://distribute.you/p?a=1#top">x</a>', textBody: "" }, ID).htmlBody).toBe(
      `<a href="https://distribute.you/p?a=1&amp;${SUBSCRIBER_LINK_PARAM}=${ID}#top">x</a>`
    );
    const out = stampSubscriberLinks(
      { htmlBody: `<a href="https://distribute.you/?dy_sub=old#pricing">x</a>`, textBody: "" },
      ID
    );
    expect(out.htmlBody).toBe(`<a href="https://distribute.you/?dy_sub=${ID}#pricing">x</a>`);
  });
});
