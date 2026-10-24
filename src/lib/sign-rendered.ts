import type { getTemplate } from "../templates/index.js";
import { isPlatformStaffAlert } from "./platform-staff-alerts.js";
import { isDistributeSender, signWithWhy } from "./why.js";
import { isFullHtmlDocument, wrapInBrandLayout } from "./brand-layout.js";
import { ADMIN_NOTIFICATION_EVENTS } from "./staff-events.js";

// The rendered message a send would put on the wire, dressed as distribute.you
// where the message is distribute.you's own word to a customer: not on a
// staff-routed alert, and not under a template that names a sender outside
// distribute.you (the legacy GrowthAgency.dev templates). Shared by the send and
// its preview so the preview cannot drift from what lands in the inbox, and by
// the Unibox feed when it replays a send made before messages were stored.
//
// A customer template whose rendered body is a fragment, not a full HTML
// document, is delivered inside the brand layout, which carries the why in its
// footer. A full document keeps its own chrome and only gets the why signed in
// if it lacks it. A template registered with layout "none" (one addressed to
// the agency inbox rather than a customer) is never wrapped.
//
// A template delivered on the "transactional" stream is person-to-person mail
// the recipient answers with Reply (instantly-service's answer-it-yourself email,
// Reply-To = the prospect). It goes out exactly as registered: no layout and no
// why. Its reply quotes the message, so a sign-off we add would travel into the
// customer's own conversation with their prospect.
export type RenderedTemplate = ReturnType<Awaited<ReturnType<typeof getTemplate>>>;
export function signRendered(eventType: string, template: RenderedTemplate): RenderedTemplate {
  // Staff mail is never signed: a platform staff alert goes out unsigned, so its preview is too
  if (ADMIN_NOTIFICATION_EVENTS.has(eventType) || isPlatformStaffAlert(eventType) || !isDistributeSender(template.from)) return template;
  if (template.stream === "transactional") return template;
  if (template.layout === "brand" && !isFullHtmlDocument(template.htmlBody)) {
    return { ...template, ...wrapInBrandLayout(template) };
  }
  return { ...template, ...signWithWhy(template, { withLink: false }) };
}
