/**
 * The template contract, and the check that enforces it.
 *
 * The renderer (`interpolate` in ./index.ts) understands ONE construct:
 * `{{name}}`, where name is letters, digits and underscores. It replaces it
 * with the metadata value, or with nothing. Every other `{{...` is left in the
 * email exactly as written: a mustache section `{{#firstName}}…{{/firstName}}`,
 * an inverted section `{{^x}}`, a triple `{{{x}}}`, a partial `{{>x}}`, a
 * comment `{{! x }}`, a dotted path `{{user.name}}`, a placeholder with spaces
 * `{{ firstName }}`, a filter `{{x | upper}}`. On 2026-10-20 a client received
 * "Hi{{#firstName}} Liudvikas{{/firstName}}," because nothing checked this.
 *
 * So the rule is simple and has no exceptions: every `{{` in a template must
 * begin a `{{name}}` placeholder. Any other `{{` is refused, at registration
 * and again at send time. A stray `}}` on its own is NOT refused: closing
 * braces appear in perfectly good HTML (inline CSS, JSON-LD `}}}`), and with
 * no `{{` before it the renderer never touches it.
 *
 * This module imports nothing (no db), so the route and the tests can use it
 * without a database.
 */

const PLACEHOLDER_AT_START = /^\{\{\w+\}\}/;

export const TEMPLATE_FIELDS = ["subject", "htmlBody", "textBody"] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

export interface UnsupportedTag {
  field: TemplateField;
  /** The offending token as written, e.g. "{{#firstName}}" */
  token: string;
}

/**
 * Every `{{` in `text` that does not begin a `{{name}}` placeholder, as the
 * token the reader would recognise (up to and including the next `}}`, or a
 * short excerpt when it is never closed). Deduplicated, in order of appearance.
 */
export function findUnsupportedTags(text: string): string[] {
  const found: string[] = [];
  let at = text.indexOf("{{");
  while (at !== -1) {
    const rest = text.slice(at);
    if (!PLACEHOLDER_AT_START.test(rest)) {
      const close = rest.indexOf("}}");
      // A triple `{{{x}}}`: include its third closing brace in the token
      const end = close === -1 ? Math.min(rest.length, 40) : close + (rest[close + 2] === "}" ? 3 : 2);
      const token = rest.slice(0, end);
      if (!found.includes(token)) found.push(token);
    }
    at = text.indexOf("{{", at + 1);
  }
  return found;
}

/** Every unsupported tag across a template's subject, html body and text body. */
export function checkTemplateSyntax(template: Partial<Record<TemplateField, string | null | undefined>>): UnsupportedTag[] {
  const problems: UnsupportedTag[] = [];
  for (const field of TEMPLATE_FIELDS) {
    const value = template[field];
    if (!value) continue;
    for (const token of findUnsupportedTags(value)) problems.push({ field, token });
  }
  return problems;
}

/** One legible sentence naming the template, the field and the token(s). */
export function describeUnsupportedTags(name: string, problems: UnsupportedTag[]): string {
  const list = problems.map((p) => `${p.token} in ${p.field}`).join(", ");
  return `Template '${name}' uses syntax the renderer does not support: ${list}. Only {{name}} placeholders (letters, digits, underscore) are replaced; anything else would reach the recipient as written. Sections ({{#x}}, {{^x}}, {{/x}}) are not supported: build the text in the caller and pass it as one variable.`;
}

/**
 * Thrown when a STORED template breaks the contract (it was registered before
 * the check existed, or written by hand). The send is refused rather than
 * delivering raw tags to a recipient.
 */
export class UnsupportedTemplateSyntaxError extends Error {
  readonly code = "unsupported_template_syntax";
  constructor(
    readonly templateName: string,
    readonly problems: UnsupportedTag[]
  ) {
    super(describeUnsupportedTags(templateName, problems));
    this.name = "UnsupportedTemplateSyntaxError";
  }
}
