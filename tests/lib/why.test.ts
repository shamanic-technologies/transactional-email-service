import { describe, it, expect } from "vitest";
import { isDistributeSender, signWithWhy } from "../../src/lib/why.js";

describe("signWithWhy", () => {
  it("places the line just before </body> when the document has one", () => {
    const out = signWithWhy({ htmlBody: "<html><BODY><p>x</p></BODY></html>", textBody: "x" }, { withLink: false });
    expect(out.htmlBody).toMatch(/<p>x<\/p><p [^>]*>Revenue made easy\.<\/p>\n<\/BODY><\/html>$/);
  });

  it("appends to a fragment", () => {
    const out = signWithWhy({ htmlBody: "<p>x</p>", textBody: "x\n\n" }, { withLink: false });
    expect(out.htmlBody.startsWith("<p>x</p>\n<p ")).toBe(true);
    expect(out.textBody).toBe("x\n\nRevenue made easy.");
  });

  it("adds the Get started link only when asked", () => {
    const out = signWithWhy({ htmlBody: "<p>x</p>", textBody: "x" }, { withLink: true });
    expect(out.htmlBody).toContain('<a href="https://distribute.you"');
    expect(out.htmlBody).toContain("Get started: distribute.you</a>");
    expect(out.textBody).toBe("x\n\nRevenue made easy.\nGet started: distribute.you");
  });

  it("never doubles a body that already carries it, part by part", () => {
    const out = signWithWhy({ htmlBody: "<p>REVENUE MADE EASY.</p>", textBody: "x" }, { withLink: false });
    expect(out.htmlBody).toBe("<p>REVENUE MADE EASY.</p>");
    expect(out.textBody).toBe("x\n\nRevenue made easy.");
  });

  it("uses no em or en dash", () => {
    const out = signWithWhy({ htmlBody: "<p>x</p>", textBody: "x" }, { withLink: true });
    expect(out.htmlBody + out.textBody).not.toMatch(/[–—]/);
  });
});

describe("isDistributeSender", () => {
  it.each([
    [null, true],
    [undefined, true],
    ["growth@distribute.you", true],
    ["Kevin <kevin@news.distribute.you>", true],
    ["GrowthAgency.dev <hello@growthagency.dev>", false],
    ["kevin@notdistribute.you", false],
  ])("%s → %s", (from, expected) => {
    expect(isDistributeSender(from)).toBe(expected);
  });
});
