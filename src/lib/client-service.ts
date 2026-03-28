/**
 * HTTP client for client-service (user/org identity resolution)
 */

import type { WorkflowHeaders } from "./runs-client.js";

const CLIENT_SERVICE_URL =
  process.env.CLIENT_SERVICE_URL || "http://localhost:3010";
const CLIENT_SERVICE_API_KEY = process.env.CLIENT_SERVICE_API_KEY || "";

interface ClientServiceUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

interface IdentityContext {
  orgId: string;
  userId: string;
  runId: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

async function clientRequest<T>(path: string, identity: IdentityContext): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": CLIENT_SERVICE_API_KEY,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
  };
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;

  const response = await fetch(`${CLIENT_SERVICE_URL}${path}`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `client-service GET ${path} failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<T>;
}

/**
 * Resolve a user's primary email from their internal user ID via client-service.
 */
export async function resolveUserEmail(userId: string, identity: IdentityContext): Promise<string> {
  const { user } = await clientRequest<{ user: ClientServiceUser }>(
    `/users/${userId}`,
    identity
  );
  if (!user.email) {
    throw new Error(`No email found for user ${userId}`);
  }
  return user.email;
}
