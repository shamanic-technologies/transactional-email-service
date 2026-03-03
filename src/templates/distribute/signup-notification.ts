import type { TemplateResult } from "../index.js";

export function signupNotification(metadata?: Record<string, unknown>): TemplateResult {
  const email = (metadata?.email as string) || "unknown";
  const timestamp = new Date().toISOString();

  return {
    subject: `New signup: ${email}`,
    htmlBody: `<p>New user signed up: <strong>${email}</strong> at ${timestamp}</p>`,
    textBody: `New user signed up: ${email} at ${timestamp}`,
  };
}
