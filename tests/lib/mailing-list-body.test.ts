import { describe, it, expect } from "vitest";
import { renderUpdateBody } from "../../src/lib/mailing-list-body.js";

describe("renderUpdateBody", () => {
  it("renders basic formatting to HTML", () => {
    const { htmlBody } = renderUpdateBody("# Title\n\nSome **bold** and a [link](https://example.com).");
    expect(htmlBody).toContain("<h1>Title</h1>");
    expect(htmlBody).toContain("<strong>bold</strong>");
    expect(htmlBody).toContain('<a href="https://example.com">link</a>');
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
