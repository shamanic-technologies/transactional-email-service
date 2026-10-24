import { createHash, randomBytes } from "node:crypto";

/**
 * Who clicked a newsletter link (NEWSLETTER-WHO-CLICKED-1024).
 *
 * Every link to one of OUR sites (distribute.you and its subdomains) in a
 * mailing-list message gains `?dy_sub=<link id>`, the subscriber's own opaque
 * id; a link anywhere else is left byte for byte as written. The landing reads
 * the parameter and asks this service who it is (`GET
 * /internal/subscriber-links/:linkId`, API key only).
 *
 * The id is 26 base64url characters: 22 of randomness (128 bits, so it cannot
 * be guessed) and a 4-character checksum of those 22. The checksum is not a
 * secret: it only lets a resolve tell a mangled or hand-edited id (`tampered`)
 * apart from a well-formed one nobody was given (`unknown`). Unforgeability
 * comes from the 128 random bits having to match a stored row, so there is no
 * signing key to provision or rotate. No email, name or phone is in it.
 */
export const SUBSCRIBER_LINK_PARAM = "dy_sub";

const RANDOM_CHARS = 22;
const CHECK_CHARS = 4;
const SHAPE = /^[A-Za-z0-9_-]{26}$/;

function checksum(random: string): string {
  return createHash("sha256").update(random).digest("base64url").slice(0, CHECK_CHARS);
}

export function mintLinkId(): string {
  const random = randomBytes(16).toString("base64url").slice(0, RANDOM_CHARS);
  return random + checksum(random);
}

/** False for anything that was not minted here intact: wrong length, alphabet or checksum. */
export function isWellFormedLinkId(raw: string): boolean {
  if (!SHAPE.test(raw)) return false;
  return checksum(raw.slice(0, RANDOM_CHARS)) === raw.slice(RANDOM_CHARS);
}

/** distribute.you itself or any subdomain of it, over http(s). */
export function isOurSite(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return host === "distribute.you" || host.endsWith(".distribute.you");
}

function stampUrl(raw: string, linkId: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (!isOurSite(url)) return raw;
  if (url.searchParams.has(SUBSCRIBER_LINK_PARAM)) {
    url.searchParams.set(SUBSCRIBER_LINK_PARAM, linkId);
    return url.toString();
  }
  // Appended as text so the authored URL keeps its exact bytes (no trailing
  // slash added, no re-encoded query), the parameter going before any fragment.
  const hashAt = raw.indexOf("#");
  const head = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : raw.slice(hashAt);
  const joiner = !head.includes("?") ? "?" : head.endsWith("?") || head.endsWith("&") ? "" : "&";
  return `${head}${joiner}${SUBSCRIBER_LINK_PARAM}=${linkId}${fragment}`;
}

const HREF = /(\bhref\s*=\s*)(["'])(.*?)\2/gi;
// A bare URL in a text part, stopping before what usually closes it in prose.
const BARE_URL = /https?:\/\/[^\s<>"'()[\]]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * The two parts of one subscriber's copy of a message. Only href attribute
 * values are touched in the HTML (visible text stays as written); in the text
 * part every bare http(s) URL is. `&amp;` in an href is decoded before parsing
 * and re-encoded after, so an authored query string survives intact.
 */
export function stampSubscriberLinks(
  body: { htmlBody: string; textBody: string },
  linkId: string
): { htmlBody: string; textBody: string } {
  const htmlBody = body.htmlBody.replace(HREF, (whole, prefix: string, quote: string, value: string) => {
    const decoded = value.replace(/&amp;/g, "&");
    const stamped = stampUrl(decoded, linkId);
    if (stamped === decoded) return whole;
    return `${prefix}${quote}${stamped.replace(/&/g, "&amp;")}${quote}`;
  });

  const textBody = body.textBody.replace(BARE_URL, (match) => {
    const trailing = match.match(TRAILING_PUNCTUATION)?.[0] ?? "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    return stampUrl(url, linkId) + trailing;
  });

  return { htmlBody, textBody };
}
