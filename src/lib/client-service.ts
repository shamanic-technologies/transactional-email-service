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

async function clientRequest<T>(path: string): Promise<T> {
  const response = await fetch(`${CLIENT_SERVICE_URL}${path}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": CLIENT_SERVICE_API_KEY,
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
export async function resolveUserEmail(userId: string): Promise<string> {
  const { user } = await clientRequest<{ user: ClientServiceUser }>(
    `/anonymous-users/${userId}`
  );
  if (!user.email) {
    throw new Error(`No email found for user ${userId}`);
  }
  return user.email;
}
