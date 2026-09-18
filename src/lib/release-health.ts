import type { DeliveryOutcomes } from "./release-pacing.js";

/**
 * The provider's own delivery outcomes for one release.
 *
 * Nothing new is produced here. Every message a release sends carries
 * `mailing-list-release-<releaseId>` as its tag, postmark-service stores that
 * tag on every message and indexes it, and email-gateway serves the aggregate
 * per operation — so one small request keyed on the tag returns the counts a
 * release is judged on. `/public/stats/by-operation` takes no identity headers,
 * which matters because the worker has no request to take them from.
 *
 * The tag, rather than the release's run: the gateway records a CHILD run it
 * mints per send against each message, so a query keyed on the release's own
 * run matches nothing and answers a clean, well-formed zero.
 */

const EMAIL_GATEWAY_SERVICE_URL = process.env.EMAIL_GATEWAY_SERVICE_URL || "https://email-gateway.distribute.you";
const EMAIL_GATEWAY_SERVICE_API_KEY = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;

interface OperationStatsResponse {
  operationId?: string;
  matched?: boolean;
  messageCount?: number;
  transactional?: {
    emailStats?: { sent?: number; bounced?: number; unsubscribed?: number };
  };
}

/**
 * Read how this release's messages actually landed.
 *
 * Returns `null` when the provider has nothing under this operation yet —
 * `matched: false`, which comes back with no stats block at all. That is NO
 * EVIDENCE YET, not a measured zero: a release polled before its first message
 * has landed is in exactly that state, and the caller asks again next tick.
 *
 * Throws when the answer cannot be had. The caller does not turn that into a
 * healthy verdict — an unanswerable question is not evidence that everything is
 * fine — it logs it and asks again on the next tick.
 */
export async function fetchDeliveryOutcomes(operationId: string): Promise<DeliveryOutcomes | null> {
  if (!EMAIL_GATEWAY_SERVICE_API_KEY) {
    throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY is not configured");
  }

  const url = `${EMAIL_GATEWAY_SERVICE_URL}/public/stats/by-operation?operationId=${encodeURIComponent(operationId)}`;
  const response = await fetch(url, {
    headers: { "X-API-Key": EMAIL_GATEWAY_SERVICE_API_KEY, Accept: "application/json" },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`email-gateway GET /public/stats/by-operation failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as OperationStatsResponse;

  if (payload.matched !== true) {
    return null;
  }

  const stats = payload.transactional?.emailStats;
  if (!stats || typeof stats.sent !== "number") {
    throw new Error(
      "email-gateway /public/stats/by-operation matched this operation and carried no transactional emailStats.sent"
    );
  }

  return {
    sent: stats.sent,
    bounced: stats.bounced ?? 0,
    unsubscribed: stats.unsubscribed ?? 0,
  };
}
