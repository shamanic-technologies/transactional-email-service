import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailTemplates } from "../db/schema.js";
import type { TemplateLayout } from "../lib/brand-layout.js";
import type { DeliveryStream } from "../lib/delivery-stream.js";
import { UnsupportedTemplateSyntaxError, checkTemplateSyntax } from "./syntax.js";

export interface TemplateResult {
  subject: string;
  htmlBody: string;
  textBody: string;
  from?: string | null;
  layout?: TemplateLayout;
  stream?: DeliveryStream;
}

type TemplateFn = (metadata?: Record<string, unknown>) => TemplateResult;

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
  const rows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.name, eventType))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`No template for event '${eventType}'`);
  }

  const row = rows[0];

  // A stored template that breaks the contract (registered before the check
  // existed, or written by hand) is refused here, before anything renders: a
  // send that would put raw tags in front of a recipient does not go out.
  // Checking the SOURCE, not the rendered output, is deliberate: a source that
  // passes can render no raw tag of its own, and a metadata value that happens
  // to contain "{{" (a prospect's text) does not block a correct template.
  const problems = checkTemplateSyntax(row);
  if (problems.length > 0) {
    throw new UnsupportedTemplateSyntaxError(row.name, problems);
  }

  return (metadata?: Record<string, unknown>) => ({
    subject: interpolate(row.subject, metadata),
    htmlBody: interpolate(row.htmlBody, metadata),
    textBody: interpolate(row.textBody, metadata),
    from: row.fromAddress,
    layout: row.layout as TemplateLayout,
    stream: row.stream as DeliveryStream,
  });
}
