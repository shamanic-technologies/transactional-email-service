import type { WorkflowHeaders } from "./runs-client.js";
import { FOUNDER_EMAIL } from "./founder.js";

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
  /** Visible copy, comma-separated. Omitted means the message carries no Cc header. */
  cc?: string;
  /** Reply address. Omitted means replies are invited to the founder. */
  replyTo?: string;
  workflowHeaders?: WorkflowHeaders;
}

// This client adds no blind copy of its own: a caller's `bcc` is forwarded
// exactly as supplied, and a caller that supplies none sends no `bcc` at all.
// The same holds for `cc`, with nothing standing behind it at any layer — a
// visible copy is only ever the addresses a caller named.
// The standing blind copy to the founder is decided in `src/routes/send.ts`,
// where a customer-facing send can be told apart from a staff-list one — a
// staff notification already reaches him as a primary recipient, and a
// mailing-list broadcast is a fan-out to many people rather than an email to a
// customer, so neither carries it.
//
// Every send does carry a reply address, defaulting to the founder, so a
// customer who hits reply reaches a human instead of wherever the sending
// address happens to route. A caller that names its own `replyTo` keeps it.

export async function sendEmail(params: SendEmailParams): Promise<void> {
  if (!EMAIL_GATEWAY_SERVICE_API_KEY) {
    throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY is not configured");
  }

  const bcc = params.bcc;
  const cc = params.cc;
  const replyTo = params.replyTo ?? FOUNDER_EMAIL;

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
      ...(cc && { cc }),
      replyTo,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(`Email sending failed (${response.status}): ${JSON.stringify(errorBody)}`);
  }
}
