/**
 * distribute.you's WHY, signed under every email the company sends its own
 * customers and newsletter readers.
 *
 * The wording is the owner's, frozen on 2026-10-03, period included. It is
 * added HERE, at render, rather than in each template, because templates are
 * registered by many owners (the dashboard, billing-service, instantly-service)
 * and one sentence that must read identically everywhere cannot be left to each
 * of them to copy.
 *
 * Where it is NOT added is decided by the callers, and each exclusion is a fact
 * about who the message is for:
 * - a staff-routed alert (it goes to us, not to a customer);
 * - a template that names its own sender outside distribute.you (the legacy
 *   GrowthAgency.dev templates: another brand's mail must carry nothing of ours).
 * Every send this service made in the 60 days to 2026-10-03 left from a
 * distribute.you address; it sends nothing on behalf of a client brand to that
 * client's own audience, and if it ever does, that send names its own sender
 * and is left untouched by the rule above.
 *
 * A body that already carries the sentence is not given it twice.
 */
export const WHY = "Revenue made easy.";
export const WHY_LINK_URL = "https://distribute.you";
export const WHY_LINK_LABEL = "Get started: distribute.you";

const MUTED = "#8b8e98";

function carriesWhy(body: string): boolean {
  return body.toLowerCase().includes(WHY.toLowerCase().replace(/\.$/, ""));
}

function insertBeforeBodyClose(html: string, fragment: string): string {
  const close = html.search(/<\/body\s*>/i);
  if (close === -1) return `${html}\n${fragment}`;
  return `${html.slice(0, close)}${fragment}\n${html.slice(close)}`;
}

/**
 * Adds the sign-off to both parts of a message. `withLink` adds the
 * "Get started" line under it, which only the newsletter carries.
 */
export function signWithWhy(
  parts: { htmlBody: string; textBody: string },
  options: { withLink: boolean }
): { htmlBody: string; textBody: string } {
  const link = options.withLink
    ? `<br /><a href="${WHY_LINK_URL}" style="color:${MUTED};">${WHY_LINK_LABEL}</a>`
    : "";
  const htmlFragment =
    `<p style="color:${MUTED};font-size:13px;line-height:1.6;margin:16px 0 24px 0;padding:0 16px;text-align:center;">` +
    `${WHY}${link}</p>`;
  const textFragment = options.withLink ? `${WHY}\n${WHY_LINK_LABEL}` : WHY;

  return {
    htmlBody: carriesWhy(parts.htmlBody) ? parts.htmlBody : insertBeforeBodyClose(parts.htmlBody, htmlFragment),
    textBody: carriesWhy(parts.textBody) ? parts.textBody : `${parts.textBody.replace(/\s+$/, "")}\n\n${textFragment}`,
  };
}

/**
 * Whether a template's sender is distribute.you's own. No sender means the
 * gateway's default, which is ours. A display-name form ("Name <a@b>") is read
 * by its address.
 */
export function isDistributeSender(from: string | null | undefined): boolean {
  if (!from) return true;
  const address = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  const domain = address.split("@")[1] ?? "";
  return domain === "distribute.you" || domain.endsWith(".distribute.you");
}
