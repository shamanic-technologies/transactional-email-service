import { marked } from "marked";

/**
 * Staff author a mailing-list update as markdown — headings, bold, links, and
 * `![alt](https://…)` inline images — and recipients receive HTML.
 *
 * The markdown source doubles as the plain-text part: it is already readable
 * prose, so no second authoring surface and no HTML-to-text heuristic.
 *
 * No unsubscribe markup is added here. email-gateway appends the discreet
 * `{{{pm:unsubscribe}}}` footer to every transactional HTML body, and Postmark
 * resolves it against the broadcast stream that carries the suppression list.
 * Adding one here would render a second, duplicate link.
 */
export function renderUpdateBody(markdown: string): { htmlBody: string; textBody: string } {
  const htmlBody = marked.parse(markdown, { async: false, gfm: true, breaks: true });

  if (typeof htmlBody !== "string") {
    throw new Error("Markdown rendering did not return a string");
  }

  return { htmlBody, textBody: markdown };
}
