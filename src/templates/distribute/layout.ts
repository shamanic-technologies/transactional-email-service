/**
 * Shared HTML email layout for Distribute emails.
 */
export function wrapInLayout(content: string): string {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
      <img src="https://distribute.you/logo-title.jpg" alt="Distribute" style="width: 180px; margin-bottom: 30px;" />
      ${content}
      <p style="color: #888; font-size: 14px; margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
        Distribute
      </p>
    </div>
  `;
}
