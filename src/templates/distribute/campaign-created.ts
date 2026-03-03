import type { TemplateResult } from "../index.js";
import { wrapInLayout } from "./layout.js";

export function campaignCreated(metadata?: Record<string, unknown>): TemplateResult {
  const campaignName = (metadata?.campaignName as string) || "Your campaign";

  return {
    subject: `Campaign created: ${campaignName}`,
    htmlBody: wrapInLayout(`
      <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 20px;">Campaign created</h1>
      
      <p style="color: #4a4a4a; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
        Your campaign <strong>${campaignName}</strong> has been created and is now live.
      </p>
      
      <p style="color: #4a4a4a; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
        <a href="https://dashboard.distribute.you" style="color: #6366f1;">View in dashboard</a>
      </p>
    `),
    textBody: `Campaign created: ${campaignName}

Your campaign "${campaignName}" has been created and is now live.

View in dashboard: https://dashboard.distribute.you

Distribute`,
  };
}
