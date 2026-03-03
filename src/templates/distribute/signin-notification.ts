import type { TemplateResult } from "../index.js";

export function signinNotification(metadata?: Record<string, unknown>): TemplateResult {
  const email = (metadata?.email as string) || "unknown";
  const timestamp = new Date().toISOString();

  return {
    subject: `Sign-in: ${email}`,
    htmlBody: `<p>User signed in: <strong>${email}</strong> at ${timestamp}</p>`,
    textBody: `User signed in: ${email} at ${timestamp}`,
  };
}
