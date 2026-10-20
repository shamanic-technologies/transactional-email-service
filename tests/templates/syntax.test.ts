import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

import { checkTemplateSyntax, findUnsupportedTags } from "../../src/templates/syntax.js";
import { interpolate } from "../../src/templates/index.js";

describe("findUnsupportedTags", () => {
  it("accepts plain {{name}} placeholders", () => {
    expect(findUnsupportedTags("Hi {{firstName}}, your {{plan_2}} is live")).toEqual([]);
  });

  it("refuses a mustache section, naming the opening and the closing tag (the 2026-10-20 email)", () => {
    expect(findUnsupportedTags("Hi{{#firstName}} {{firstName}}{{/firstName}},")).toEqual(["{{#firstName}}", "{{/firstName}}"]);
  });

  it.each([
    ["{{^firstName}}there{{/firstName}}", "{{^firstName}}"],
    ["{{{rawHtml}}}", "{{{rawHtml}}}"],
    ["{{> footer}}", "{{> footer}}"],
    ["{{! note }}", "{{! note }}"],
    ["{{ firstName }}", "{{ firstName }}"],
    ["{{user.name}}", "{{user.name}}"],
    ["{{first-name}}", "{{first-name}}"],
    ["{{x | upper}}", "{{x | upper}}"],
    ["Hi {{firstName", "{{firstName"],
  ])("refuses %s", (text, token) => {
    expect(findUnsupportedTags(text)).toContain(token);
  });

  it("leaves closing braces alone when no tag opens them (inline CSS, JSON-LD)", () => {
    const html = '<style>@media (max-width:600px){.a{color:red}}</style><script type="application/ld+json">{"a":{"name":"{{firstName}}"}}}</script>';
    expect(findUnsupportedTags(html)).toEqual([]);
  });

  it("a template that passes renders no raw tag of its own", () => {
    const source = 'Hi {{firstName}}, {"x":{"y":"{{brand}}"}}}';
    expect(findUnsupportedTags(source)).toEqual([]);
    expect(interpolate(source, { firstName: "Ada" })).not.toContain("{{");
  });
});

describe("checkTemplateSyntax", () => {
  it("names the field each token is in", () => {
    expect(checkTemplateSyntax({ subject: "{{#a}}x{{/a}}", htmlBody: "<p>{{ok}}</p>", textBody: "{{^b}}y{{/b}}" })).toEqual([
      { field: "subject", token: "{{#a}}" },
      { field: "subject", token: "{{/a}}" },
      { field: "textBody", token: "{{^b}}" },
      { field: "textBody", token: "{{/b}}" },
    ]);
  });
});
