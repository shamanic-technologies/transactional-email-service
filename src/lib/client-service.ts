/**
 * HTTP client for client-service (user/org identity resolution)
 */

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
}

async function clientRequest<T>(path: string, identity: IdentityContext): Promise<T> {
  const response = await fetch(`${CLIENT_SERVICE_URL}${path}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": CLIENT_SERVICE_API_KEY,
      "x-org-id": identity.orgId,
      "x-user-id": identity.userId,
      "x-run-id": identity.runId,
    },
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
