/**
 * Lenient parser for a pasted blob of email addresses.
 *
 * Staff paste whatever they have: comma-separated, newline-separated,
 * `Name <email>` pairs, trailing semicolons, tabs, duplicates. The parser
 * accepts all of that, normalises to a lower-cased address, and reports every
 * fragment it could not read rather than dropping it silently.
 */

export interface ParsedBlob {
  /** Valid, de-duplicated addresses, lower-cased, in first-seen order. */
  emails: string[];
  /** Fragments that are not email addresses, with the reason. */
  rejected: Array<{ value: string; reason: string }>;
  /** Fragments that repeated an address already seen in this same blob. */
  duplicates: string[];
}

// Deliberately pragmatic, not RFC 5322: one @, no whitespace, a dot-bearing
// domain. Anything stricter rejects addresses that deliver fine in practice.
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * Pull the address out of a single fragment. Handles `Name <a@b.com>`,
 * `<a@b.com>`, `"Name" a@b.com` and a bare address.
 */
function extractAddress(fragment: string): string | null {
  const angled = fragment.match(/<([^<>]+)>/);
  const candidate = (angled ? angled[1] : fragment).trim().replace(/^["']|["']$/g, "");
  if (EMAIL_RE.test(candidate)) return candidate.toLowerCase();

  // Bare `Name a@b.com` with no angle brackets: take the last whitespace-delimited
  // token that looks like an address.
  if (!angled) {
    const tokens = candidate.split(/\s+/).filter(Boolean);
    const match = tokens.reverse().find((t) => EMAIL_RE.test(t));
    if (match) return match.toLowerCase();
  }

  return null;
}

export function parseAddressBlob(raw: string): ParsedBlob {
  const fragments = raw
    .split(/[,;\n\r\t]+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  const emails: string[] = [];
  const rejected: Array<{ value: string; reason: string }> = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const fragment of fragments) {
    const address = extractAddress(fragment);
    if (!address) {
      rejected.push({ value: fragment, reason: "not a valid email address" });
      continue;
    }
    if (seen.has(address)) {
      duplicates.push(address);
      continue;
    }
    seen.add(address);
    emails.push(address);
  }

  return { emails, rejected, duplicates };
}
