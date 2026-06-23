import type { WorkflowHeaders } from "./runs-client.js";

const EMAIL_GATEWAY_SERVICE_URL = process.env.EMAIL_GATEWAY_SERVICE_URL || "https://email-gateway.distribute.you";
const EMAIL_GATEWAY_SERVICE_API_KEY = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;

interface SendEmailParams {
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  tag: string;
  orgId: string;
  userId: string;
  runId: string;
  brandIds?: string[];
  campaignId?: string;
  from?: string | null;
  bcc?: string;
  workflowHeaders?: WorkflowHeaders;
}

/**
 * Merge a caller-supplied comma-separated bcc list with the static staff bcc
 * configured via TRANSACTIONAL_BCC_EMAILS. Trims whitespace, drops empties, and
 * de-duplicates (case-insensitive) preserving first-seen order. Returns
 * undefined when no addresses remain so the gateway body omits `bcc` entirely.
 */
function mergeBcc(callerBcc?: string): string | undefined {
  const addresses = [callerBcc, process.env.TRANSACTIONAL_BCC_EMAILS]
    .filter((list): list is string => Boolean(list))
    .flatMap((list) => list.split(","))
    .map((addr) => addr.trim())
    .filter((addr) => addr.length > 0);

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const addr of addresses) {
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(addr);
  }

  return deduped.length > 0 ? deduped.join(",") : undefined;
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  if (!EMAIL_GATEWAY_SERVICE_API_KEY) {
    throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY is not configured");
  }

  const bcc = mergeBcc(params.bcc);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": EMAIL_GATEWAY_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
  if (params.workflowHeaders?.campaignId) headers["x-campaign-id"] = params.workflowHeaders.campaignId;
  if (params.workflowHeaders?.brandId) headers["x-brand-id"] = params.workflowHeaders.brandId;
  if (params.workflowHeaders?.workflowSlug) headers["x-workflow-slug"] = params.workflowHeaders.workflowSlug;
  if (params.workflowHeaders?.featureSlug) headers["x-feature-slug"] = params.workflowHeaders.featureSlug;
  if (params.workflowHeaders?.audienceId) headers["x-audience-id"] = params.workflowHeaders.audienceId;

  const response = await fetch(`${EMAIL_GATEWAY_SERVICE_URL}/orgs/send`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "transactional",
      ...(params.campaignId && { campaignId: params.campaignId }),
      runId: params.runId,
      clerkOrgId: params.orgId,
      to: params.to,
      recipientFirstName: "",
      recipientLastName: "",
      recipientCompany: "",
      subject: params.subject,
      htmlBody: params.htmlBody,
      textBody: params.textBody,
      tag: params.tag,
      ...(params.from && { from: params.from }),
      ...(bcc && { bcc }),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(`Email sending failed (${response.status}): ${JSON.stringify(errorBody)}`);
  }
}
