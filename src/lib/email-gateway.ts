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
  /** Acting user, when there is one. Omitted for user-less machine callers. */
  userId?: string;
  runId: string;
  brandIds?: string[];
  campaignId?: string;
  from?: string | null;
  bcc?: string;
  workflowHeaders?: WorkflowHeaders;
}

// No staff address is blind-copied here. Postmark bills per recipient and
// counts blind copies, so a standing staff bcc multiplied every send by the
// size of the staff list. The internal visibility it provided is already
// covered twice over: Postmark keeps the full message in its Activity archive
// for 45 days, and postmark-service stores a permanent metadata row per send.
// Only a caller's own `bcc` reaches the provider, exactly as supplied.

export async function sendEmail(params: SendEmailParams): Promise<void> {
  if (!EMAIL_GATEWAY_SERVICE_API_KEY) {
    throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY is not configured");
  }

  const bcc = params.bcc;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": EMAIL_GATEWAY_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-run-id": params.runId,
  };
  if (params.userId) headers["x-user-id"] = params.userId;
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
