import { Marked, type Token, type Tokens } from "marked";

/**
 * Staff author a mailing-list update as markdown — headings, bold, links, and
 * `![alt](https://…)` inline images — and recipients receive HTML.
 *
 * Every style is written onto the element itself. Gmail discards `<head>` and
 * any `<style>` block, and Outlook's Word engine ignores most of what survives,
 * so a stylesheet renders correctly in a browser preview and arrives unstyled
 * in the inbox. Nothing here relies on flexbox, grid, custom properties or
 * class attributes for the same reason: older clients drop them silently and
 * the message collapses to default browser markup.
 *
 * Layout is a centred table rather than a styled `<div>`, because table
 * geometry is the one thing every client — including Outlook — agrees on. The
 * column is capped at 600px for a readable measure and set to `width:100%` so a
 * phone renders it edge-to-edge with no horizontal scrolling.
 *
 * The markdown source doubles as the plain-text part: it is already readable
 * prose, so no second authoring surface and no HTML-to-text heuristic.
 *
 * No unsubscribe markup is added here. email-gateway appends the discreet
 * `{{{pm:unsubscribe}}}` footer to every transactional HTML body, and Postmark
 * resolves it against the broadcast stream that carries the suppression list.
 * Adding one here would render a second, duplicate link.
 */

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_STACK = "SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const INK = "#1f2937";
const HEADING_INK = "#111827";
const MUTED_INK = "#4b5563";
const LINK_INK = "#1d4ed8";
const RULE = "#e5e7eb";
const HAIRLINE = "#eef0f3";
const TINT = "#f6f7f9";
const PAGE = "#f4f5f7";

const BODY_TEXT = `margin:0 0 16px 0;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:${INK};`;
const LIST_TEXT = `font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:${INK};`;

/** h4 and deeper all land on the smallest step; markdown rarely goes that far. */
const HEADING_STYLE: Record<number, string> = {
  1: `margin:0 0 16px 0;font-family:${FONT_STACK};font-size:26px;line-height:1.25;font-weight:700;color:${HEADING_INK};`,
  2: `margin:32px 0 12px 0;font-family:${FONT_STACK};font-size:20px;line-height:1.3;font-weight:700;color:${HEADING_INK};`,
  3: `margin:24px 0 8px 0;font-family:${FONT_STACK};font-size:17px;line-height:1.4;font-weight:700;color:${HEADING_INK};`,
  4: `margin:20px 0 8px 0;font-family:${FONT_STACK};font-size:14px;line-height:1.4;font-weight:700;color:${MUTED_INK};text-transform:uppercase;letter-spacing:0.04em;`,
};

/**
 * Mirrors marked's own `cleanUrl`, which it does not export: an href that
 * cannot be encoded is not a URL, and the caller renders the text instead.
 */
function cleanUrl(href: string): string | null {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function alignStyle(align: "center" | "left" | "right" | null): string {
  return `text-align:${align ?? "left"};`;
}

/**
 * Fixed layout needs the widths stated, and an even split is the wrong default:
 * the first column carries the label ("Net revenue retention") while the rest
 * carry short figures, so an even split is what breaks "$31,200" across two
 * lines on a phone. Give the label a third and let the figures share the rest.
 */
function columnWidth(index: number, columns: number): number {
  if (columns < 2) return 100;
  if (index === 0) return 34;
  return Math.round((66 / (columns - 1)) * 100) / 100;
}

const renderer = new Marked({ gfm: true, breaks: true });

renderer.use({
  renderer: {
    heading(this: any, { tokens, depth }: Tokens.Heading) {
      const tag = `h${Math.min(depth, 6)}`;
      const style = HEADING_STYLE[Math.min(depth, 4)];
      return `<${tag} style="${style}">${this.parser.parseInline(tokens)}</${tag}>\n`;
    },

    paragraph(this: any, { tokens }: Tokens.Paragraph) {
      return `<p style="${BODY_TEXT}">${this.parser.parseInline(tokens)}</p>\n`;
    },

    strong(this: any, { tokens }: Tokens.Strong) {
      return `<strong style="font-weight:700;color:${HEADING_INK};">${this.parser.parseInline(tokens)}</strong>`;
    },

    list(this: any, token: Tokens.List) {
      const tag = token.ordered ? "ol" : "ul";
      const start = token.ordered && Number(token.start) > 1 ? ` start="${token.start}"` : "";
      const items = token.items.map((item: Tokens.ListItem) => this.listitem(item)).join("");
      return `<${tag}${start} style="margin:0 0 16px 0;padding:0 0 0 22px;${LIST_TEXT}">\n${items}</${tag}>\n`;
    },

    listitem(this: any, item: Tokens.ListItem) {
      return `<li style="margin:0 0 8px 0;${LIST_TEXT}">${this.parser.parse(item.tokens, !!item.loose)}</li>\n`;
    },

    link(this: any, { href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const clean = cleanUrl(href);
      if (clean === null) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${clean}"${titleAttr} style="color:${LINK_INK};text-decoration:underline;">${text}</a>`;
    },

    /**
     * `max-width:100%` keeps an oversized image inside the 600px column in
     * every client that honours it; no `width` is set, so a small image is
     * never upscaled.
     */
    image(this: any, { href, title, text, tokens }: Tokens.Image) {
      const alt = tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text;
      const clean = cleanUrl(href);
      if (clean === null) return escapeHtml(alt);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${clean}" alt="${escapeHtml(alt)}"${titleAttr} style="display:block;max-width:100%;height:auto;margin:0 0 16px 0;border:0;border-radius:6px;">`;
    },

    /**
     * Investor updates carry numbers, so the table is the block most likely to
     * break a phone. It is sized in percentages rather than pixels, sized down a
     * step, and every cell wraps — nothing here can force horizontal scroll.
     *
     * `table-layout:fixed` is what makes that last claim true. Under the default
     * automatic layout a table is never narrower than its content, so on a phone
     * the widest row pushes the table past the column, the layout tables around
     * it stretch to follow, and the whole message scrolls sideways — measured at
     * 401px of document for a 375px screen. Fixed layout takes the column widths
     * from the header row instead, and the cells wrap inside them.
     */
    table(this: any, token: Tokens.Table) {
      const header = token.header
        .map(
          (cell: Tokens.TableCell, i: number) =>
            `<th width="${columnWidth(i, token.header.length)}%" style="width:${columnWidth(i, token.header.length)}%;padding:8px 10px;font-family:${FONT_STACK};font-size:12px;font-weight:700;color:${MUTED_INK};text-transform:uppercase;letter-spacing:0.03em;background-color:${TINT};border-bottom:1px solid ${RULE};overflow-wrap:break-word;${alignStyle(token.align[i])}">${this.parser.parseInline(cell.tokens)}</th>`
        )
        .join("");

      const rows = token.rows
        .map((row: Tokens.TableCell[]) => {
          const cells = row
            .map(
              (cell: Tokens.TableCell, i: number) =>
                `<td style="padding:8px 10px;font-family:${FONT_STACK};font-size:14px;line-height:1.5;color:${INK};border-bottom:1px solid ${HAIRLINE};overflow-wrap:break-word;${alignStyle(token.align[i])}">${this.parser.parseInline(cell.tokens)}</td>`
            )
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("\n");

      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;margin:0 0 20px 0;border-collapse:collapse;border:1px solid ${RULE};border-radius:6px;">\n` +
        `<thead><tr>${header}</tr></thead>\n` +
        `<tbody>\n${rows}\n</tbody>\n` +
        `</table>\n`
      );
    },

    /** A full-perimeter tint, never a thick side rule — that reads as generic. */
    blockquote(this: any, { tokens }: Tokens.Blockquote) {
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 16px 0;border-collapse:collapse;">` +
        `<tr><td style="padding:16px 18px;background-color:${TINT};border:1px solid ${RULE};border-radius:6px;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:${MUTED_INK};">${this.parser.parse(tokens)}</td></tr>` +
        `</table>\n`
      );
    },

    code({ text }: Tokens.Code) {
      return `<pre style="margin:0 0 16px 0;padding:14px 16px;background-color:${TINT};border:1px solid ${RULE};border-radius:6px;font-family:${MONO_STACK};font-size:14px;line-height:1.5;color:${INK};white-space:pre-wrap;word-break:break-word;">${escapeHtml(text)}</pre>\n`;
    },

    codespan({ text }: Tokens.Codespan) {
      return `<code style="padding:2px 6px;background-color:${TINT};border:1px solid ${RULE};border-radius:4px;font-family:${MONO_STACK};font-size:14px;color:${INK};">${escapeHtml(text)}</code>`;
    },

    hr() {
      return `<hr style="height:1px;margin:32px 0;border:0;background-color:${RULE};color:${RULE};">\n`;
    },
  },
});

/**
 * Wraps the rendered blocks in the email shell: a full-width background table,
 * a centred 600px card, and one padded content cell carrying the base font so
 * any element the renderer did not style still inherits something sane.
 *
 * email-gateway appends its unsubscribe footer after this markup, so the footer
 * sits below the card on the page background — visible, and exactly once.
 */
function wrap(content: string): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:${PAGE};">\n` +
    `<tr><td align="center" style="padding:32px 16px;">\n` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;background-color:#ffffff;border:1px solid ${RULE};border-radius:10px;">\n` +
    `<tr><td style="padding:36px 28px;font-family:${FONT_STACK};font-size:16px;line-height:1.6;color:${INK};">\n` +
    content +
    `</td></tr>\n</table>\n` +
    `</td></tr>\n</table>\n`
  );
}

/** Gmail, Outlook and Yahoo all refuse `image/svg+xml` and show the alt text. */
const UNRENDERABLE_IMAGE_RE = /^data:image\/svg\+xml|\.svgz?($|[?#])/i;

function collectImageHrefs(tokens: Token[] | undefined, found: string[]): void {
  if (!tokens) return;
  for (const token of tokens) {
    const t = token as any;
    if (t.type === "image" && typeof t.href === "string") found.push(t.href);
    collectImageHrefs(t.tokens, found);
    if (Array.isArray(t.items)) collectImageHrefs(t.items, found);
    if (Array.isArray(t.header)) {
      for (const cell of t.header) collectImageHrefs(cell.tokens, found);
    }
    if (Array.isArray(t.rows)) {
      for (const row of t.rows) for (const cell of row) collectImageHrefs(cell.tokens, found);
    }
  }
}

/**
 * Returns every image URL in the body that the recipients' clients cannot
 * render, so the send fails with the reason instead of arriving as a broken
 * placeholder. The sender knows the body before it goes out, which makes this
 * the last place the defect is cheap to catch: the admin console rejects SVG
 * where the author pastes a URL, but that guards one authoring surface, not
 * the API.
 *
 * Covers both markdown images and the raw `<img>` tags markdown also allows.
 */
export function findUnrenderableImages(markdown: string): string[] {
  const hrefs: string[] = [];
  collectImageHrefs(renderer.lexer(markdown) as unknown as Token[], hrefs);

  for (const match of markdown.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    hrefs.push(match[1]);
  }

  return [...new Set(hrefs.filter((href) => UNRENDERABLE_IMAGE_RE.test(href.trim())))];
}

export function renderUpdateBody(markdown: string): { htmlBody: string; textBody: string } {
  const content = renderer.parse(markdown, { async: false });

  if (typeof content !== "string") {
    throw new Error("Markdown rendering did not return a string");
  }

  return { htmlBody: wrap(content), textBody: markdown };
}
