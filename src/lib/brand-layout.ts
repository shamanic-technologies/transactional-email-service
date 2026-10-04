import { WHY } from "./why.js";

/**
 * distribute.you's email chrome, owned here so every customer email looks the
 * same whichever service registered its template.
 *
 * Before this, only the dashboard wrapped its templates (its `emailLayout()` in
 * apps/dashboard/src/instrumentation.ts); billing-service, instantly-service and
 * campaign-service registered bare fragments like `<p>{{intro}}</p>` and the
 * customer got an unstyled email. The markup below is the dashboard's, byte for
 * byte, so a wrapped fragment and a dashboard template are indistinguishable.
 *
 * Which bodies are wrapped is decided in `src/routes/send.ts`; this module only
 * knows how to wrap and how to tell a full document from a fragment.
 */

const DASHBOARD_URL = "https://dashboard.distribute.you";
const DOCS_URL = "https://docs.distribute.you";
/** The official full logo on a light background (PNG: Gmail and Outlook do not render SVG). */
const LOGO_URL = "https://distribute.you/brand/logo-full-on-light.png";

const EMAIL_BG = "#fafaf8";
const EMAIL_SURFACE = "#ffffff";
const EMAIL_TEXT = "#0a0a14";
const EMAIL_MUTED = "#8b8e98";
const EMAIL_BORDER = "rgba(10,10,20,0.08)";
const EMAIL_FONT =
  "'Space Grotesk','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The template's layout setting: "brand" wraps a fragment, "none" sends as registered. */
export const TEMPLATE_LAYOUTS = ["brand", "none"] as const;
export type TemplateLayout = (typeof TEMPLATE_LAYOUTS)[number];

/** The plain-text sign-off the dashboard's templates end with. */
export const TEXT_SIGNOFF = `--\ndistribute.you\n${WHY}`;

/**
 * A body that is already a whole document carries its own chrome and is never
 * wrapped. Read after interpolation, because a template like `{{html}}` only
 * becomes a document (or not) once the caller's metadata is in it.
 */
export function isFullHtmlDocument(html: string): boolean {
  return /<!doctype\s+html|<html[\s>]/i.test(html);
}

export function brandLayout(content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background-color:${EMAIL_BG};font-family:${EMAIL_FONT};-webkit-font-smoothing:antialiased;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="margin-bottom:28px;"><img src="${LOGO_URL}" width="170" height="32" alt="distribute.you" style="display:block;border:0;outline:none;text-decoration:none;height:32px;width:170px;" /></div>
    <div style="background:${EMAIL_SURFACE};border:1px solid ${EMAIL_BORDER};border-radius:12px;padding:36px 32px;">
      ${content}
    </div>
    <p style="color:${EMAIL_TEXT};font-size:15px;font-weight:600;line-height:1.5;margin:28px 0 0;text-align:center;">${WHY}</p>
    <p style="color:${EMAIL_MUTED};font-size:13px;line-height:1.6;margin-top:6px;text-align:center;">
      Done-for-you cold outreach, sent from our domains on your behalf.<br />
      <a href="${DASHBOARD_URL}" style="color:${EMAIL_MUTED};">Dashboard</a> &nbsp;·&nbsp; <a href="${DOCS_URL}" style="color:${EMAIL_MUTED};">Docs</a>
    </p>
  </div>
</body>
</html>`;
}

/**
 * Wraps a rendered fragment in the layout, and ends its plain-text part with
 * the dashboard's sign-off unless it already carries the why.
 */
export function wrapInBrandLayout(parts: { htmlBody: string; textBody: string }): { htmlBody: string; textBody: string } {
  const carriesWhy = parts.textBody.toLowerCase().includes(WHY.toLowerCase().replace(/\.$/, ""));
  const text = parts.textBody.replace(/\s+$/, "");
  return {
    htmlBody: brandLayout(parts.htmlBody),
    textBody: carriesWhy ? parts.textBody : text ? `${text}\n\n${TEXT_SIGNOFF}` : TEXT_SIGNOFF,
  };
}
