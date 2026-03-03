import type { TemplateResult } from "../index.js";

export function userActive(metadata?: Record<string, unknown>): TemplateResult {
  const email = (metadata?.email as string) || "unknown";
  const timestamp = new Date().toISOString();

  return {
    subject: `User active: ${email}`,
    htmlBody: `<p>User is back: <strong>${email}</strong> at ${timestamp}</p>`,
    textBody: `User is back: ${email} at ${timestamp}`,
  };
}
