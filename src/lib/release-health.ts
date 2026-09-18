import type { DeliveryOutcomes } from "./release-pacing.js";

/**
 * The provider's own delivery outcomes for one release.
 *
 * Nothing new is produced here. Every message a release sends carries the
 * release's run id, postmark-service already ingests Postmark's bounce and
 * complaint webhooks against it, and email-gateway aggregates that by run — so
 * one small request keyed on the run returns the counts a release is judged on.
 * `/public/stats` takes no identity headers, which matters because the worker
 * has no request to take them from.
 */

const EMAIL_GATEWAY_SERVICE_URL = process.env.EMAIL_GATEWAY_SERVICE_URL || "https://email-gateway.distribute.you";
const EMAIL_GATEWAY_SERVICE_API_KEY = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;

interface StatsResponse {
  transactional?: {
    emailStats?: { sent?: number; bounced?: number; unsubscribed?: number };
  };
}

/**
 * Read how this release's messages actually landed.
 *
 * Throws when the answer cannot be had. The caller does not turn that into a
 * healthy verdict — an unanswerable question is not evidence that everything is
 * fine — it logs it and asks again on the next tick.
 */
export async function fetchDeliveryOutcomes(runId: string): Promise<DeliveryOutcomes> {
  if (!EMAIL_GATEWAY_SERVICE_API_KEY) {
    throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY is not configured");
  }

  const url = `${EMAIL_GATEWAY_SERVICE_URL}/public/stats?type=transactional&runIds=${encodeURIComponent(runId)}`;
  const response = await fetch(url, {
    headers: { "X-API-Key": EMAIL_GATEWAY_SERVICE_API_KEY, Accept: "application/json" },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`email-gateway GET /public/stats failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as StatsResponse;
  const stats = payload.transactional?.emailStats;
  if (!stats || typeof stats.sent !== "number") {
    throw new Error("email-gateway /public/stats returned no transactional emailStats.sent for this run");
  }

  return {
    sent: stats.sent,
    bounced: stats.bounced ?? 0,
    unsubscribed: stats.unsubscribed ?? 0,
  };
}
