// security_alert (SECURITY-ALERTS-1128): an intrusion signal raised by a fleet
// watcher (key-service key-read audit, api-service request audit, the box's
// Caddy / egress / Cloudflare-audit / Postgres / SSH / vendor-key watchers).
// Owner 2026-11-28, after the 2026-11-20 break-in: EMAILED to the staff list
// AND red on dashboard v2 Monitoring. It is the second explicit exception to
// "a monitoring alert is never emailed", so it is NOT in MONITORING_ALERTS
// (that list means recorded-only); it is in EMAILED_MONITORING_ALERTS, which
// only puts it on the Monitoring feed. One email per incident: the caller's
// eventId names the incident, never one request.
//
// The evidence quotes what an ATTACKER chose (a path, a user agent, a token
// name), and the renderer interpolates raw text. So the HTML body never reads
// a caller value directly: it reads `*Html` variables built here, escaped,
// with line breaks kept. The text body and subject read the raw values (the
// subject with line breaks folded to spaces).
//
// `test: "true"` in the metadata marks a watcher's proof-of-fire replay: since
// SECURITY-ALERTS-OURS-1128 it is recorded only (lib/security-origin.ts), never
// emailed, never red; the `[TEST] ` subject prefix stays for a preview.
//
// Own module: route tests `vi.mock` their dependencies whole.
export const SECURITY_ALERT = "security_alert";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isTestAlert(metadata: Record<string, unknown>): boolean {
  return str(metadata.test).toLowerCase() === "true";
}

/** The variables the security_alert template reads, derived from the caller's metadata. */
export function securityAlertTemplateVars(metadata: Record<string, unknown>): Record<string, string> {
  const kind = str(metadata.kind);
  const summary = str(metadata.summary).replace(/[\r\n]+/g, " ");
  const evidence = str(metadata.evidence);
  const firstSeenAt = str(metadata.firstSeenAt);
  const firstSeenLine = firstSeenAt ? `First seen: ${firstSeenAt}` : "";
  return {
    subjectPrefix: isTestAlert(metadata) ? "[TEST] " : "",
    kind,
    summary,
    evidence,
    firstSeenLine,
    kindHtml: escapeHtml(kind),
    summaryHtml: escapeHtml(summary),
    evidenceHtml: escapeHtml(evidence).replace(/\r?\n/g, "<br>"),
    firstSeenHtml: firstSeenAt ? escapeHtml(firstSeenAt) : "not stated",
  };
}
