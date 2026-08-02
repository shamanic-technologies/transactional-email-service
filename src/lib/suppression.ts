/**
 * Provider suppression state for the mailing-list surfaces.
 *
 * This service stores no opt-out flag of its own. Postmark's broadcast stream
 * owns the suppression list — that is what the native one-click unsubscribe,
 * a spam complaint and a hard bounce all write to — so the list read and the
 * send both read it back live.
 *
 * It is read from Postmark directly, using the platform Postmark token
 * resolved through key-service, because that list is the only authoritative
 * copy. postmark-service's own mirror is org-scoped and only covers addresses
 * we have already messaged under that organisation, so it reports a suppressed
 * address as subscribed — verified in prod on 2026-08-02, where an address
 * Postmark had suppressed as a HardBounce since June read back as subscribed
 * through the mirror and the send was silently accepted but never delivered.
 *
 * Fail loud: a lookup that errors throws. Displaying a suppressed member as
 * subscribed, or mailing one, is worse than refusing to answer.
 */

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "http://localhost:3001";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;
const POSTMARK_API_URL = "https://api.postmarkapp.com";

export interface SuppressionIdentity {
  orgId: string;
  userId: string;
}

export interface SuppressionEntry {
  /** "HardBounce" | "SpamComplaint" | "ManualSuppression" — Postmark's own wording. */
  reason: string;
}

export interface SuppressionLookup {
  /** True when Postmark is suppressing sends to this address. */
  isSuppressed(email: string): boolean;
  /** Postmark's reason for suppressing, or null when it is not suppressed. */
  reasonFor(email: string): string | null;
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

/**
 * Read the suppression list of the Postmark broadcast stream — the same stream
 * postmark-service resolves server-side for every send.
 */
export async function fetchSuppressed(
  identity: SuppressionIdentity,
  callerPath: string
): Promise<SuppressionLookup> {
  const [serverToken, streamId] = await Promise.all([
    resolveKey("postmark", identity, callerPath),
    resolveKey("postmark-broadcast-stream", identity, callerPath),
  ]);

  const response = await fetch(
    `${POSTMARK_API_URL}/message-streams/${encodeURIComponent(streamId)}/suppressions/dump`,
    { headers: { "X-Postmark-Server-Token": serverToken, Accept: "application/json" } }
  );

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

  const suppressed = new Map<string, string>();
  for (const entry of payload.Suppressions) {
    if (!entry.EmailAddress) continue;
    suppressed.set(entry.EmailAddress.toLowerCase(), entry.SuppressionReason ?? "Suppressed");
  }

  return {
    isSuppressed: (email: string) => suppressed.has(email.toLowerCase()),
    reasonFor: (email: string) => suppressed.get(email.toLowerCase()) ?? null,
  };
}
