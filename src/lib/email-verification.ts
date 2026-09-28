import type { MailingListRelease } from "../db/schema.js";

/**
 * Pre-send verdicts for a slice of a mailing-list release, from apollo-service.
 *
 * apollo-service owns email verification (BounceVerify: real SMTP + catch-all
 * detection) together with its bronze table, its 30-day verdict reuse and its
 * cost protocol. `POST /email-verifications` bills each fresh verification to
 * the release's org as a child run of the release's run — the identity the
 * release row already carries, since this worker has no request of its own.
 *
 * Only verdict `valid` may be sent. Apollo's own `email_status: verified` is
 * not a usable filter: 97% of the newsletter list carried it and 132 of its
 * first 138 bounces did too.
 *
 * Fails loud. A non-2xx answer, a timeout, or an answer that does not name a
 * verdict for every address asked THROWS, and the caller sends nothing from
 * that slice. There is no "assume deliverable" branch anywhere.
 */

export type EmailVerdict = "valid" | "invalid" | "catch_all" | "risky" | "unknown";

const VERDICTS: ReadonlySet<string> = new Set(["valid", "invalid", "catch_all", "risky", "unknown"]);

/** THE policy switch: the one verdict a release sends to. */
export const SENDABLE_VERDICT: EmailVerdict = "valid";

/** apollo-service's own ceiling per call. A release slice (MAX_TICK_BATCH) is below it. */
export const VERIFY_CHUNK = 50;

/**
 * Well under CLAIM_STALE_MS (10 min): a slice waiting on its verdicts must never
 * outlive its claim and be settled as "interrupted" by the stale-claim sweep.
 */
const VERIFY_TIMEOUT_MS = 5 * 60_000;

export interface Verdict {
  email: string;
  verdict: EmailVerdict;
  verificationId: string;
}

export class VerificationUnavailableError extends Error {
  constructor(message: string) {
    super(`email verification unavailable: ${message}`);
    this.name = "VerificationUnavailableError";
  }
}

function config(): { url: string; apiKey: string } {
  const url = process.env.APOLLO_SERVICE_URL;
  const apiKey = process.env.APOLLO_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new VerificationUnavailableError("APOLLO_SERVICE_URL and APOLLO_SERVICE_API_KEY must be set");
  }
  return { url, apiKey };
}

function identityHeaders(release: MailingListRelease): Record<string, string> {
  const headers: Record<string, string> = {
    "x-org-id": release.orgId,
    "x-user-id": release.userId,
    "x-run-id": release.runId,
  };
  if (release.brandIds?.length) headers["x-brand-id"] = release.brandIds.join(",");
  if (release.campaignId) headers["x-campaign-id"] = release.campaignId;
  if (release.audienceId) headers["x-audience-id"] = release.audienceId;
  if (release.featureSlug) headers["x-feature-slug"] = release.featureSlug;
  if (release.workflowSlug) headers["x-workflow-slug"] = release.workflowSlug;
  return headers;
}

async function verifyChunk(release: MailingListRelease, emails: string[]): Promise<Verdict[]> {
  const { url, apiKey } = config();
  let response: Response;
  try {
    response = await fetch(`${url}/email-verifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, ...identityHeaders(release) },
      body: JSON.stringify({ emails, source: "transactional-email-service:mailing-list-release" }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new VerificationUnavailableError(`apollo-service unreachable: ${err?.message ?? String(err)}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new VerificationUnavailableError(`apollo-service POST /email-verifications ${response.status}: ${text.slice(0, 500)}`);
  }

  let body: { results?: Array<{ email?: unknown; verdict?: unknown; verificationId?: unknown }> };
  try {
    body = JSON.parse(text);
  } catch {
    throw new VerificationUnavailableError(`apollo-service returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(body.results)) {
    throw new VerificationUnavailableError("apollo-service answered without a results array");
  }

  const verdicts: Verdict[] = [];
  for (const r of body.results) {
    if (typeof r.email !== "string" || typeof r.verdict !== "string" || !VERDICTS.has(r.verdict) || typeof r.verificationId !== "string") {
      throw new VerificationUnavailableError(`apollo-service returned a malformed result: ${JSON.stringify(r).slice(0, 200)}`);
    }
    verdicts.push({ email: r.email.toLowerCase(), verdict: r.verdict as EmailVerdict, verificationId: r.verificationId });
  }
  return verdicts;
}

/**
 * A verdict for EVERY address given, keyed by the lower-cased address. Throws
 * VerificationUnavailableError if one cannot be had for any of them.
 */
export async function fetchVerdicts(release: MailingListRelease, emails: string[]): Promise<Map<string, Verdict>> {
  const byEmail = new Map<string, Verdict>();
  for (let offset = 0; offset < emails.length; offset += VERIFY_CHUNK) {
    for (const v of await verifyChunk(release, emails.slice(offset, offset + VERIFY_CHUNK))) {
      byEmail.set(v.email, v);
    }
  }
  const missing = emails.filter((e) => !byEmail.has(e.toLowerCase()));
  if (missing.length > 0) {
    throw new VerificationUnavailableError(`no verdict returned for ${missing.length} address(es): ${missing.slice(0, 5).join(", ")}`);
  }
  return byEmail;
}
