/**
 * Measures the subscribers read against a stand-in for key-service and Postmark.
 *
 * Not a benchmark of our own CPU work — the whole cost of this read is network
 * round trips and the size of what comes back — so the stand-in serves real
 * HTTP over loopback with a fixed delay injected per hop, and the suppression
 * dump it serves is a real Postmark-shaped payload of a configurable size.
 *
 * Run: npx tsx scripts/bench-suppression.mts
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Round-trip to key-service, Railway-internal. */
const KEY_SERVICE_RTT_MS = 15;
/** Round-trip to Postmark, over the public internet from Railway. */
const POSTMARK_RTT_MS = 120;
/**
 * Loopback moves a 7 MB body in a few milliseconds, which would hide the one
 * cost this change is about, so the stand-in also spends the time the body
 * would take on a real link.
 */
const DOWNLINK_MBPS = 50;
/** Addresses on the mailing list being rendered. */
const LIST_SIZE = 12;
/** Addresses on the broadcast stream's suppression list — shared with all outreach. */
const STREAM_SUPPRESSION_SIZES = [500, 5_000, 50_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function suppressionEntry(index: number) {
  return {
    EmailAddress: `suppressed-${index}@some-prospect-domain-${index}.com`,
    SuppressionReason: index % 3 === 0 ? "HardBounce" : index % 3 === 1 ? "SpamComplaint" : "ManualSuppression",
    Origin: "Recipient",
    CreatedAt: "2026-06-12T09:41:02Z",
  };
}

/** The whole-stream dump the stand-in currently serves; swapped per size below. */
let wholeStreamBody = "";

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://localhost");

  if (url.pathname.startsWith("/keys/")) {
    await sleep(KEY_SERVICE_RTT_MS);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ key: url.pathname.includes("broadcast-stream") ? "broadcast" : "server-token" }));
    return;
  }

  // Filtered: Postmark answers about the one address asked for. Unfiltered: the
  // whole stream comes back.
  const body = url.searchParams.has("EmailAddress") ? JSON.stringify({ Suppressions: [] }) : wholeStreamBody;

  await sleep(POSTMARK_RTT_MS + (Buffer.byteLength(body) * 8) / (DOWNLINK_MBPS * 1000));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

process.env.KEY_SERVICE_API_KEY = "bench";
process.env.KEY_SERVICE_URL = baseUrl;

// The module pins Postmark's host, so point loopback at it for the bench.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) =>
  realFetch(String(input).replace("https://api.postmarkapp.com", baseUrl), init)) as typeof fetch;

const { fetchSuppressed, resetSuppressionCache } = await import("../src/lib/suppression.js");

/** The read as it was before this change: two decrypts, then the whole stream. */
async function readTheOldWay(emails: string[]) {
  const [serverToken] = await Promise.all([
    fetch(`${baseUrl}/keys/postmark/decrypt`).then((r) => r.json()) as Promise<{ key: string }>,
    fetch(`${baseUrl}/keys/postmark-broadcast-stream/decrypt`).then((r) => r.json()) as Promise<{ key: string }>,
  ]);

  const response = await fetch(`${baseUrl}/message-streams/broadcast/suppressions/dump`, {
    headers: { "X-Postmark-Server-Token": serverToken.key },
  });
  const payload = (await response.json()) as { Suppressions: Array<{ EmailAddress: string; SuppressionReason: string }> };

  const suppressed = new Map(payload.Suppressions.map((e) => [e.EmailAddress.toLowerCase(), e.SuppressionReason]));
  return emails.map((email) => suppressed.has(email.toLowerCase()));
}

async function timed(label: string, run: () => Promise<unknown>) {
  const started = performance.now();
  await run();
  console.log(`  ${label.padEnd(46)} ${(performance.now() - started).toFixed(0).padStart(5)} ms`);
}

const emails = Array.from({ length: LIST_SIZE }, (_, i) => `member-${i}@fund.com`);

console.log(
  `Subscribers read — list of ${LIST_SIZE}, key-service ${KEY_SERVICE_RTT_MS}ms/hop, ` +
    `Postmark ${POSTMARK_RTT_MS}ms/hop at ${DOWNLINK_MBPS} Mbit/s\n`
);

for (const streamSize of STREAM_SUPPRESSION_SIZES) {
  wholeStreamBody = JSON.stringify({
    Suppressions: Array.from({ length: streamSize }, (_, i) => suppressionEntry(i)),
  });

  console.log(
    `Broadcast stream suppressing ${streamSize.toLocaleString()} addresses ` +
      `(${(Buffer.byteLength(wholeStreamBody) / 1024).toFixed(0)} KB dump):`
  );

  await timed("before — full dump, cold", () => readTheOldWay(emails));
  await timed("before — full dump, immediate refresh", () => readTheOldWay(emails));

  resetSuppressionCache();
  await timed("after  — per address, cold", () => fetchSuppressed({ orgId: "org", userId: "u" }, "/bench", emails));
  await timed("after  — per address, immediate refresh", () =>
    fetchSuppressed({ orgId: "org", userId: "u" }, "/bench", emails)
  );
  await timed("after  — send path (no reuse at all)", () =>
    fetchSuppressed({ orgId: "org", userId: "u" }, "/bench", emails, { maxAgeMs: 0 })
  );

  console.log("");
}

globalThis.fetch = realFetch;
server.close();
