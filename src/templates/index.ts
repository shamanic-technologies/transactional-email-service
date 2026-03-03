import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailTemplates } from "../db/schema.js";
import * as distribute from "./distribute/index.js";
import * as generic from "./generic/index.js";

export interface TemplateResult {
  subject: string;
  htmlBody: string;
  textBody: string;
  from?: string | null;
}

type TemplateFn = (metadata?: Record<string, unknown>) => TemplateResult;

const hardcodedRegistry: Record<string, TemplateFn> = {
  ...distribute.templates,
  ...generic.templates,
};

/**
 * Replace {{variable}} placeholders with values from metadata.
 * Unknown placeholders are left as empty strings.
 */
export function interpolate(template: string, metadata?: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = metadata?.[key];
    return value != null ? String(value) : "";
  });
}

export async function getTemplate(eventType: string): Promise<TemplateFn> {
  // Check DB-registered templates first
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.name, eventType))
    .limit(1);

  if (rows.length > 0) {
    const row = rows[0];
    return (metadata?: Record<string, unknown>) => ({
      subject: interpolate(row.subject, metadata),
      htmlBody: interpolate(row.htmlBody, metadata),
      textBody: interpolate(row.textBody, metadata),
      from: row.fromAddress,
    });
  }

  // Fall back to hardcoded templates
  const template = hardcodedRegistry[eventType];
  if (!template) {
    throw new Error(`No template for event '${eventType}'`);
  }
  return template;
}
