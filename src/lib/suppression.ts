/**
 * Provider suppression state for the mailing-list surfaces.
 *
 * This service stores no opt-out flag of its own. Postmark's broadcast stream
 * owns the suppression list — that is what the native one-click unsubscribe,
 * a spam complaint and a hard bounce all write to — so the list read and the
 * send both read it back from Postmark.
 *
 * It is read from Postmark directly, using the platform Postmark token
 * resolved through key-service, because that list is the only authoritative
 * copy. postmark-service's own mirror is org-scoped and only covers addresses
 * we have already messaged under that organisation, so it reports a suppressed
 * address as subscribed — verified in prod on 2026-08-02, where an address
 * Postmark had suppressed as a HardBounce since June read back as subscribed
 * through the mirror and the send was silently accepted but never delivered.
 *
 * Two things keep that read cheap without weakening it:
 *
 *  - **Only the addresses we are about to render or mail are read.** Postmark's
 *    suppression dump takes an `EmailAddress` filter, so a list of twelve
 *    members costs twelve small answers, asked concurrently, rather than one
 *    dump of the whole broadcast stream. That stream is shared with all
 *    outreach, so an unfiltered dump grows with total send volume and is
 *    unrelated in size to the list being read. Past `MAX_FILTERED_LOOKUPS`
 *    addresses the filtered form would need a second wave and one dump becomes
 *    the cheaper answer, so a long list takes that instead — either way the
 *    read is one round trip.
 *  - **A short-lived in-process cache**, holding both the resolved credentials
 *    and each address's answer. A staff member refreshing the subscribers page
 *    hits it; the first request on a cold process does not.
 *
 * A send never reads through the cache: it asks for a maximum age of zero, so
 * every recipient is re-checked against Postmark at send time. An address that
 * opted out one second ago is skipped by that send even though a page load a
 * moment earlier still had it cached as subscribed.
 *
 * Fail loud: a lookup that errors throws, and nothing is cached from a failed
 * lookup. Displaying a suppressed member as subscribed, or mailing one, is
 * worse than refusing to answer.
 */

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "http://localhost:3001";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;
const POSTMARK_API_URL = "https://api.postmarkapp.com";

/**
 * How long a cached suppression answer may be reused by a read. Short enough
 * that the staff console is never meaningfully behind Postmark, long enough
 * that refreshing the page costs nothing.
 */
export const SUPPRESSION_TTL_MS = 60_000;

/** Credentials change only when they are rotated, so they are held longer. */
export const CREDENTIAL_TTL_MS = 5 * 60_000;

/**
 * How many addresses are read individually before one dump of the whole stream
 * becomes the cheaper answer.
 *
 * Both shapes cost one round trip: this many filtered lookups run concurrently,
 * and the dump is a single request. Past this count the filtered form would
 * need a second wave, so a list longer than this takes the dump instead — that
 * keeps a large list from turning into hundreds of requests, and keeps a small
 * one from paying for the whole stream.
 */
export const MAX_FILTERED_LOOKUPS = 20;

export interface SuppressionIdentity {
  orgId: string;
  userId: string;
}

export interface SuppressionLookup {
  /** True when Postmark is suppressing sends to this address. */
  isSuppressed(email: string): boolean;
  /** Postmark's reason for suppressing, or null when it is not suppressed. */
  reasonFor(email: string): string | null;
}

export interface SuppressionOptions {
  /**
   * Largest age, in milliseconds, of a cached answer this caller will accept.
   * Reads take the default. A send passes 0, which re-checks every recipient
   * against Postmark and refreshes the cache with what it finds.
   */
  maxAgeMs?: number;
}

interface Credentials {
  serverToken: string;
  streamId: string;
}

interface Cached<T> {
  value: T;
  storedAt: number;
}

const credentialCache = new Map<string, Cached<Credentials>>();
/** Keyed by `${streamId}\n${lower-cased address}`; the value is Postmark's reason, or null. */
const suppressionCache = new Map<string, Cached<string | null>>();

/** Drops every cached credential and suppression answer. For tests. */
export function resetSuppressionCache(): void {
  credentialCache.clear();
  suppressionCache.clear();
}

function isFresh<T>(entry: Cached<T> | undefined, maxAgeMs: number): entry is Cached<T> {
  // Strictly less than, so a caller asking for a maximum age of zero always
  // re-reads — even when the cached answer was stored in this same millisecond.
  return entry !== undefined && Date.now() - entry.storedAt < maxAgeMs;
}

async function resolveKey(provider: string, identity: SuppressionIdentity, callerPath: string): Promise<string> {
  if (!KEY_SERVICE_API_KEY) {
    throw new Error("KEY_SERVICE_API_KEY is not configured");
  }

  const response = await fetch(`${KEY_SERVICE_URL}/keys/${encodeURIComponent(provider)}/decrypt`, {
    headers: {
      "x-api-key": KEY_SERVICE_API_KEY,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "X-Caller-Service": "transactional-email-service",
      "X-Caller-Method": "GET",
      "X-Caller-Path": callerPath,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`key-service GET /keys/${provider}/decrypt failed: ${response.status} - ${errorText}`);
  }

  const payload = (await response.json()) as { key?: string };
  if (!payload.key) {
    throw new Error(`key-service returned no key for '${provider}'`);
  }
  return payload.key;
}

async function resolveCredentials(identity: SuppressionIdentity, callerPath: string): Promise<Credentials> {
  const cached = credentialCache.get(identity.orgId);
  if (isFresh(cached, CREDENTIAL_TTL_MS)) return cached.value;

  const [serverToken, streamId] = await Promise.all([
    resolveKey("postmark", identity, callerPath),
    resolveKey("postmark-broadcast-stream", identity, callerPath),
  ]);

  const credentials = { serverToken, streamId };
  credentialCache.set(identity.orgId, { value: credentials, storedAt: Date.now() });
  return credentials;
}

/**
 * Read the broadcast stream's suppression list, optionally narrowed to a single
 * address. Returns each suppressed address Postmark reported, with its reason.
 */
async function readStream(credentials: Credentials, email?: string): Promise<Map<string, string>> {
  const url =
    `${POSTMARK_API_URL}/message-streams/${encodeURIComponent(credentials.streamId)}/suppressions/dump` +
    (email ? `?EmailAddress=${encodeURIComponent(email)}` : "");

  const response = await fetch(url, {
    headers: { "X-Postmark-Server-Token": credentials.serverToken, Accept: "application/json" },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Postmark suppression dump failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    Suppressions?: Array<{ EmailAddress?: string; SuppressionReason?: string }>;
  };

  if (!Array.isArray(payload.Suppressions)) {
    throw new Error("Postmark suppression dump returned no Suppressions array");
  }

  // Postmark filters server-side, but key by the address it reported rather
  // than trusting a non-empty answer to be about the address we asked for.
  const suppressed = new Map<string, string>();
  for (const entry of payload.Suppressions) {
    if (!entry.EmailAddress) continue;
    suppressed.set(entry.EmailAddress.toLowerCase(), entry.SuppressionReason ?? "Suppressed");
  }
  return suppressed;
}

/**
 * Read the suppression state of these addresses in one round trip: individually
 * when they fit in a single concurrent wave, otherwise from one dump of the
 * whole stream.
 */
async function readAll(credentials: Credentials, emails: string[]): Promise<Map<string, string | null>> {
  const answers = new Map<string, string | null>();

  if (emails.length > MAX_FILTERED_LOOKUPS) {
    const suppressed = await readStream(credentials);
    for (const email of emails) answers.set(email, suppressed.get(email) ?? null);
    return answers;
  }

  const found = await Promise.all(emails.map((email) => readStream(credentials, email)));
  emails.forEach((email, index) => answers.set(email, found[index].get(email) ?? null));
  return answers;
}

/**
 * Read the suppression state of the given addresses on the Postmark broadcast
 * stream — the same stream postmark-service resolves server-side for every
 * send. Only these addresses are read; the whole stream is never dumped.
 *
 * The returned lookup answers only for the addresses passed in. Asking it about
 * anything else throws, so a caller can never mistake "I did not check that
 * address" for "that address is fine".
 */
export async function fetchSuppressed(
  identity: SuppressionIdentity,
  callerPath: string,
  emails: string[],
  options: SuppressionOptions = {}
): Promise<SuppressionLookup> {
  const maxAgeMs = options.maxAgeMs ?? SUPPRESSION_TTL_MS;
  const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];

  const answers = new Map<string, string | null>();

  if (wanted.length > 0) {
    // The stream id is part of the cache key, so credentials come first.
    const credentials = await resolveCredentials(identity, callerPath);
    const toRead: string[] = [];

    for (const email of wanted) {
      const cached = suppressionCache.get(`${credentials.streamId}\n${email}`);
      if (isFresh(cached, maxAgeMs)) answers.set(email, cached.value);
      else toRead.push(email);
    }

    if (toRead.length > 0) {
      const read = await readAll(credentials, toRead);
      for (const [email, reason] of read) {
        answers.set(email, reason);
        suppressionCache.set(`${credentials.streamId}\n${email}`, { value: reason, storedAt: Date.now() });
      }
    }
  }

  function reasonFor(email: string): string | null {
    const key = email.trim().toLowerCase();
    if (!answers.has(key)) {
      throw new Error(`Suppression state for '${email}' was never read — it was not part of this lookup`);
    }
    return answers.get(key)!;
  }

  return {
    isSuppressed: (email: string) => reasonFor(email) !== null,
    reasonFor,
  };
}
