import { describe, it, expect } from "vitest";
import { findUnrenderableImages, renderUpdateBody } from "../../src/lib/mailing-list-body.js";

const FULL_UPDATE = [
  "# Q3 investor update",
  "",
  "Revenue grew and we **shipped** the new [pricing page](https://distribute.you/pricing).",
  "",
  "## Highlights",
  "",
  "- Closed two enterprise accounts",
  "- Churn down to 1.2%",
  "",
  "| Metric | Q2 | Q3 |",
  "| --- | ---: | ---: |",
  "| MRR | $41k | $58k |",
  "| Customers | 190 | 244 |",
  "",
  "![Growth chart](https://distribute.you/brand/icon.png)",
].join("\n");

describe("renderUpdateBody", () => {
  it("renders basic formatting to HTML", () => {
    const { htmlBody } = renderUpdateBody("# Title\n\nSome **bold** and a [link](https://example.com).");
    expect(htmlBody).toContain("Title</h1>");
    expect(htmlBody).toContain("bold</strong>");
    expect(htmlBody).toContain('href="https://example.com"');
  });

  it("renders an inline image", () => {
    const { htmlBody } = renderUpdateBody("![Q3 chart](https://cdn.example.com/q3.png)");
    expect(htmlBody).toContain('<img src="https://cdn.example.com/q3.png" alt="Q3 chart"');
  });

  it("sends the markdown source as the plain-text part", () => {
    const markdown = "# Title\n\nBody text.";
    expect(renderUpdateBody(markdown).textBody).toBe(markdown);
  });

  it("keeps single newlines as line breaks", () => {
    const { htmlBody } = renderUpdateBody("line one\nline two");
    expect(htmlBody).toContain("<br>");
  });

  it("adds no unsubscribe markup — email-gateway appends the provider one", () => {
    const { htmlBody } = renderUpdateBody("Hello investors.");
    expect(htmlBody).not.toMatch(/unsubscribe/i);
  });
});

describe("renderUpdateBody — inlined styling", () => {
  const { htmlBody } = renderUpdateBody(FULL_UPDATE);

  it("relies on no <style> block, no <head>, and no class attributes", () => {
    expect(htmlBody).not.toMatch(/<style\b/i);
    expect(htmlBody).not.toMatch(/<head\b/i);
    expect(htmlBody).not.toMatch(/\bclass\s*=/i);
    expect(htmlBody).not.toMatch(/var\(--/);
  });

  it("uses no layout primitive older clients drop", () => {
    expect(htmlBody).not.toMatch(/display\s*:\s*(flex|grid|inline-flex|inline-grid)/i);
    expect(htmlBody).not.toMatch(/\bgrid-template|\bflex-direction|\bgap\s*:/i);
    expect(htmlBody).not.toMatch(/\bposition\s*:\s*(absolute|fixed|sticky)/i);
  });

  it("constrains the measure to a fluid 600px column", () => {
    expect(htmlBody).toContain("max-width:600px");
    expect(htmlBody).toContain('role="presentation"');
    // width:100% alongside the cap is what keeps a phone free of side-scroll.
    expect(htmlBody).toContain("width:100%;max-width:600px");
  });

  it("styles every block it emits, inline", () => {
    for (const tag of ["<h1", "<h2", "<p ", "<ul", "<li", "<a ", "<img", "<th ", "<td "]) {
      const at = htmlBody.indexOf(tag);
      expect(at, `no ${tag} in rendered body`).toBeGreaterThan(-1);
      expect(htmlBody.slice(at, htmlBody.indexOf(">", at)), `${tag} carries no style`).toContain(
        'style="'
      );
    }
  });

  it("gives headings a hierarchy rather than browser defaults", () => {
    const h1 = htmlBody.slice(htmlBody.indexOf("<h1"), htmlBody.indexOf("</h1>"));
    const h2 = htmlBody.slice(htmlBody.indexOf("<h2"), htmlBody.indexOf("</h2>"));
    expect(h1).toContain("font-size:26px");
    expect(h2).toContain("font-size:20px");
    expect(h1).toContain("font-weight:700");
  });

  it("keeps the table inside the column and wrapping on a phone", () => {
    // The data table, not the layout shell — the shell legitimately caps at 600px.
    const opensAt = htmlBody.lastIndexOf("<table role", htmlBody.indexOf("<thead"));
    const dataTable = htmlBody.slice(opensAt, htmlBody.indexOf("</table>", opensAt));
    // break-word, not anywhere: "$41,200" stays whole until it genuinely cannot fit.
    expect(dataTable).toContain("overflow-wrap:break-word");
    expect(dataTable).not.toMatch(/width\s*:\s*\d+px/);
    expect(htmlBody).toContain("border-collapse:collapse");
  });

  it("keeps an image inside the column and never upscales it", () => {
    const img = htmlBody.slice(htmlBody.indexOf("<img"), htmlBody.indexOf(">", htmlBody.indexOf("<img")));
    expect(img).toContain("max-width:100%");
    expect(img).toContain("height:auto");
    expect(img).not.toMatch(/(?<!-)\bwidth\s*[:=]/);
  });

  it("renders blockquotes, code and rules with a full-perimeter treatment", () => {
    const { htmlBody: quoted } = renderUpdateBody("> A quote\n\n`code`\n\n---\n");
    expect(quoted).toContain("border:1px solid");
    expect(quoted).not.toMatch(/border-left\s*:\s*[2-9]/);
    expect(quoted).toContain("<code style=");
    expect(quoted).toContain("<hr style=");
  });

  it("escapes markup in alt text and code rather than emitting it", () => {
    const { htmlBody: escaped } = renderUpdateBody(
      '![<script>x</script>](https://cdn.example.com/a.png)\n\n`<b>raw</b>`'
    );
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&lt;b&gt;raw&lt;/b&gt;");
  });

  it("still emits no unsubscribe markup for a full update", () => {
    expect(htmlBody).not.toMatch(/unsubscribe/i);
  });

  it("still sends the markdown as a genuine text alternative", () => {
    const { textBody } = renderUpdateBody(FULL_UPDATE);
    expect(textBody).toBe(FULL_UPDATE);
    expect(textBody).not.toMatch(/<[a-z]/i);
    expect(textBody).toContain("Q3 investor update");
    expect(textBody).toContain("Closed two enterprise accounts");
  });
});

describe("findUnrenderableImages", () => {
  it("flags an SVG no mail client renders", () => {
    expect(findUnrenderableImages("![Logo](https://distribute.you/brand/icon.svg)")).toEqual([
      "https://distribute.you/brand/icon.svg",
    ]);
  });

  it("flags an SVG carrying a query string or fragment", () => {
    expect(findUnrenderableImages("![Logo](https://cdn.example.com/l.svg?v=2)")).toEqual([
      "https://cdn.example.com/l.svg?v=2",
    ]);
    expect(findUnrenderableImages("![Logo](https://cdn.example.com/l.svgz#a)")).toEqual([
      "https://cdn.example.com/l.svgz#a",
    ]);
  });

  it("flags an inline SVG data URI", () => {
    expect(findUnrenderableImages("![Logo](data:image/svg+xml;base64,PHN2Zz4=)")).toHaveLength(1);
  });

  it("flags a raw <img> tag, not only markdown syntax", () => {
    expect(findUnrenderableImages('<img src="https://cdn.example.com/chart.svg" alt="Chart">')).toEqual([
      "https://cdn.example.com/chart.svg",
    ]);
  });

  it("finds an SVG nested in a list or a table cell", () => {
    expect(findUnrenderableImages("- ![a](https://cdn.example.com/a.svg)")).toHaveLength(1);
    expect(
      findUnrenderableImages("| Logo |\n| --- |\n| ![b](https://cdn.example.com/b.svg) |")
    ).toHaveLength(1);
  });

  it("passes PNG, JPEG and GIF through", () => {
    expect(findUnrenderableImages(FULL_UPDATE)).toEqual([]);
    expect(
      findUnrenderableImages(
        "![a](https://x.test/a.png) ![b](https://x.test/b.jpg) ![c](https://x.test/c.gif)"
      )
    ).toEqual([]);
  });

  it("does not flag a link that merely points at an SVG page", () => {
    expect(findUnrenderableImages("[our logo](https://distribute.you/brand/icon.svg)")).toEqual([]);
  });

  it("reports each offending URL once", () => {
    const md = "![a](https://x.test/a.svg)\n\n![again](https://x.test/a.svg)";
    expect(findUnrenderableImages(md)).toEqual(["https://x.test/a.svg"]);
  });
});
