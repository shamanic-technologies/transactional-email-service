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
  brandId?: string;
  campaignId?: string;
  from?: string | null;
  workflowHeaders?: WorkflowHeaders;
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  if (!EMAIL_GATEWAY_SERVICE_API_KEY) {
    throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY is not configured");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": EMAIL_GATEWAY_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
  if (params.workflowHeaders?.campaignId) headers["x-campaign-id"] = params.workflowHeaders.campaignId;
  if (params.workflowHeaders?.brandId) headers["x-brand-id"] = params.workflowHeaders.brandId;
  if (params.workflowHeaders?.workflowName) headers["x-workflow-name"] = params.workflowHeaders.workflowName;

  const response = await fetch(`${EMAIL_GATEWAY_SERVICE_URL}/send`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "transactional",
      ...(params.brandId && { brandId: params.brandId }),
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
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(`Email sending failed (${response.status}): ${JSON.stringify(errorBody)}`);
  }
}
