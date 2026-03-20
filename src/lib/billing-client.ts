/**
 * HTTP client for billing-service credit authorization
 * BLOCKING: must succeed before paid operations proceed
 */

import type { WorkflowHeaders } from "./runs-client.js";

const BILLING_SERVICE_URL =
  process.env.BILLING_SERVICE_URL || "http://localhost:3012";
const BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY || "";

// Cost item for a single transactional email send
export const EMAIL_COST_NAME = "postmark-email-send";
export const EMAIL_COST_QUANTITY = 1;

export interface CostItem {
  costName: string;
  quantity: number;
}

export interface AuthorizeParams {
  items: CostItem[];
  description: string;
  orgId: string;
  userId: string;
  runId: string;
  workflowHeaders?: WorkflowHeaders;
}

export interface AuthorizeResponse {
  sufficient: boolean;
  balance_cents: number | null;
  required_cents: number | null;
  billing_mode: "trial" | "byok" | "payg";
}

export async function authorizeCredits(
  params: AuthorizeParams
): Promise<AuthorizeResponse> {
  const { items, description, orgId, userId, runId, workflowHeaders } =
    params;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": BILLING_SERVICE_API_KEY,
    "x-org-id": orgId,
    "x-user-id": userId,
    "x-run-id": runId,
  };
  if (workflowHeaders?.campaignId)
    headers["x-campaign-id"] = workflowHeaders.campaignId;
  if (workflowHeaders?.brandId)
    headers["x-brand-id"] = workflowHeaders.brandId;
  if (workflowHeaders?.workflowName)
    headers["x-workflow-name"] = workflowHeaders.workflowName;

  const response = await fetch(
    `${BILLING_SERVICE_URL}/v1/credits/authorize`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        items,
        description,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `billing-service POST /v1/credits/authorize failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<AuthorizeResponse>;
}
