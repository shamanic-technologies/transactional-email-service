// The only event types that may be sent with NO organisation and NO user, on
// the platform's dime (POST /platform-orgless-send). Each one exists because
// the person it is for has no account yet, so there is no org to name and no
// customer to bill. Keep this list closed and short: every name here is a
// template anyone holding the service key can mail to an arbitrary address
// at our expense.
//
// agent_signup_code: client-service's one-time sign-up code for an AI agent
// opening an account against an email (owner, 2026-10-12). The template is
// registered by client-service at boot; the code and its lifetime are required.
//
// Its own module: tests `vi.mock` route dependencies whole, and src/schemas.ts
// reads this list at import time.
export const ORGLESS_PLATFORM_EVENTS: Record<string, readonly string[]> = {
  agent_signup_code: ["code", "expiresInMinutes"],
};

export function isOrglessPlatformEvent(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(ORGLESS_PLATFORM_EVENTS, eventType);
}
