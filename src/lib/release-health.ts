import type { DeliveryOutcomes } from "./release-pacing.js";

/**
 * The provider's own delivery outcomes for one release.
 *
 * Nothing new is produced here. Every message a release sends carries the
 * release's run as `x-run-id`, postmark-service persists that as each message's
 * PARENT run, and email-gateway aggregates exactly that set — so one small
 * request keyed on the release's run returns the counts a release is judged on.
 * `/public/stats/by-operation` takes no identity headers, which matters because
 * the worker has no request to take them from.
 *
 * Two handles were tried before this one and both were wrong in the same
 * direction — quietly, in the answer that reads as healthy. `runIds` on
 * `/stats` means the CHILD run the provider mints per send, so the release's own
 * run matched nothing and the answer was a well-formed zero. Keying on the send
 * TAG then matched too much: a tag is per-TEMPLATE in storage, so one release's
 * question returned every release that ever used the same template. The parent
 * run is the only handle that is exactly this release's mail, no more and no
 * less.
 */

const EMAIL_GATEWAY_SERVICE_URL = process.env.EMAIL_GATEWAY_SERVICE_URL || "https://email-gateway.distribute.you";
const EMAIL_GATEWAY_SERVICE_API_KEY = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;

interface OperationStatsResponse {
  matched?: boolean;
  messagesMatched?: number;
  transactional?: {
    emailStats?: { sent?: number; bounced?: number; unsubscribed?: number };
  };
}

/**
 * Read how this release's messages actually landed, given the run it sends
 * every one of them under.
 *
 * Throws when the answer cannot be had — including when the gateway reports the
 * release as matching no messages at all. An unmatched operation is not a
 * release with zero bounces; it is a question that found nothing, and the
 * caller must not turn it into a healthy verdict. It logs it and asks again on
 * the next tick.
 */
export async function fetchDeliveryOutcomes(operationRunId: string): Promise<DeliveryOutcomes> {
  if (!EMAIL_GATEWAY_SERVICE_API_KEY) {
    throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY is not configured");
  }

  const url = `${EMAIL_GATEWAY_SERVICE_URL}/public/stats/by-operation?operationRunId=${encodeURIComponent(operationRunId)}`;
  const response = await fetch(url, {
    headers: { "X-API-Key": EMAIL_GATEWAY_SERVICE_API_KEY, Accept: "application/json" },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`email-gateway GET /public/stats/by-operation failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as OperationStatsResponse;

  if (payload.matched !== true) {
    throw new Error(
      `email-gateway reports no message under run ${operationRunId} — the question found nothing, which is not a verdict`
    );
  }

  const stats = payload.transactional?.emailStats;
  if (!stats || typeof stats.sent !== "number") {
    throw new Error("email-gateway /public/stats/by-operation matched an operation but served no transactional emailStats.sent");
  }

  return {
    sent: stats.sent,
    bounced: stats.bounced ?? 0,
    unsubscribed: stats.unsubscribed ?? 0,
  };
}
