import { z } from "zod";
import { MAX_DAILY_LIMIT } from "./lib/release-pacing.js";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- POST /send ---

export const SendRequestSchema = z
  .object({
    eventType: z.string().openapi({
      description:
        "Event type determining which template to use and which dedup strategy applies. " +
        "Once-only events (waitlist, welcome, signup_notification): sent at most once per recipient. " +
        "Daily events (user_active): sent at most once per recipient per day. " +
        "Product-scoped events (webinar_welcome, j_minus_3, j_minus_2, j_minus_1, j_day): sent once per recipient per productId. " +
        "Monthly per-brand events (audience_fully_contacted): sent at most once per org per brand per calendar month. " +
        "Org-daily events (provider_credits_exhausted): sent at most once per org per calendar day, with no recipient in the key. " +
        "Any other event type has NO dedup and will send every time. " +
        "Staff notification events (signup_notification, signin_notification, user_active, brand_daily_budget_changed, payment_method_removed, staff_daily_digest, provider_credits_exhausted) are delivered to the internal staff recipient list, never to the customer.",
    }),
    brandIds: z.array(z.string()).optional().openapi({ description: "Brand IDs for tracking (one or more UUIDs)" }),
    campaignId: z.string().optional().openapi({ description: "Campaign ID for tracking" }),
    productId: z.string().optional().openapi({ description: "Product/instance ID, required for product-scoped dedup (e.g. webinar ID)" }),
    recipientEmail: z.string().email().optional().openapi({ description: "Direct recipient email (overrides client-service resolution if provided)" }),
    bccEmails: z.array(z.string().email()).optional().openapi({
      description:
        "Blind-copy recipient email addresses, forwarded as provider-level BCC recipients and never rendered into templates or stored in metadata. On a customer-facing event kevin@distribute.you is added to whatever is supplied here; on a staff-routed event nothing is added.",
    }),
    ccEmails: z.array(z.string().email()).optional().openapi({
      description:
        "Visible-copy recipient email addresses, forwarded as provider-level Cc recipients and never rendered into templates or stored in metadata. Every recipient of the message can see them on the Cc header, and a reply-all reaches them. Nothing is ever added here: a caller that names none gets no Cc at all. Rejected on the staff-routed events that already refuse a caller-supplied recipient list.",
    }),
    metadata: z.record(z.string(), z.unknown()).optional().openapi({ description: "Template variables for {{variable}} interpolation" }),
  })
  .openapi("SendRequest");

export type SendRequest = z.infer<typeof SendRequestSchema>;

export const SendResultSchema = z
  .object({
    email: z.string(),
    sent: z.boolean(),
    reason: z.string().optional(),
  })
  .openapi("SendResult");

export const SendResponseSchema = z
  .object({
    results: z.array(SendResultSchema),
  })
  .openapi("SendResponse");

export type SendResponse = z.infer<typeof SendResponseSchema>;

// --- Health ---

export const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
  })
  .openapi("HealthResponse");

// --- Error ---

export const ErrorResponseSchema = z
  .object({
    error: z.string(),
    details: z.unknown().optional(),
  })
  .openapi("ErrorResponse");

// --- Stats ---

export const StatsQuerySchema = z
  .object({
    eventType: z.string().optional(),
  })
  .openapi("StatsQuery");

export type StatsQuery = z.infer<typeof StatsQuerySchema>;

export const StatsResponseSchema = z
  .object({
    stats: z.object({
      totalEmails: z.number(),
      sent: z.number(),
      failed: z.number(),
    }),
  })
  .openapi("StatsResponse");

// --- PUT /templates ---

export const TemplateItemSchema = z
  .object({
    name: z.string().min(1),
    subject: z.string().min(1),
    htmlBody: z.string().min(1),
    textBody: z.string().optional().default(""),
    from: z.string().optional().openapi({ description: "Sender address for this template, e.g. \"Display Name <email@domain.com>\". If omitted, the email gateway default is used." }),
  })
  .openapi("TemplateItem");

export const DeployTemplatesRequestSchema = z
  .object({
    templates: z.array(TemplateItemSchema).min(1),
  })
  .openapi("DeployTemplatesRequest");

export type DeployTemplatesRequest = z.infer<typeof DeployTemplatesRequestSchema>;

export const DeployTemplateResultSchema = z
  .object({
    name: z.string(),
    action: z.enum(["created", "updated"]),
  })
  .openapi("DeployTemplateResult");

export const DeployTemplatesResponseSchema = z
  .object({
    templates: z.array(DeployTemplateResultSchema),
  })
  .openapi("DeployTemplatesResponse");

// --- POST /internal/transfer-brand ---

export const TransferBrandRequestSchema = z
  .object({
    sourceBrandId: z.string().uuid(),
    sourceOrgId: z.string().uuid(),
    targetOrgId: z.string().uuid(),
    targetBrandId: z.string().uuid().optional(),
  })
  .openapi("TransferBrandRequest");

export const TransferBrandTableResultSchema = z
  .object({
    tableName: z.string(),
    count: z.number(),
  })
  .openapi("TransferBrandTableResult");

export const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(TransferBrandTableResultSchema),
  })
  .openapi("TransferBrandResponse");

// --- Mailing lists (platform-level, staff-only) ---

export const MailingListSubscriberSchema = z
  .object({
    email: z.string(),
    optedOut: z.boolean().openapi({
      description:
        "True when Postmark is suppressing sends to this address — the member used the native unsubscribe, complained, or hard-bounced. Read from the Postmark broadcast stream's suppression list, per address, and reused for up to a minute; this service stores no opt-out flag of its own. A send re-checks every recipient against Postmark and never reuses that answer.",
    }),
    optedOutReason: z.string().nullable().openapi({
      description: "Postmark's own reason: \"ManualSuppression\" (unsubscribed), \"SpamComplaint\" or \"HardBounce\". Null when not suppressed.",
    }),
    addedAt: z.string().openapi({ format: "date-time" }),
  })
  .openapi("MailingListSubscriber");

export const MailingListSubscribersResponseSchema = z
  .object({
    slug: z.string(),
    count: z.number(),
    subscribers: z.array(MailingListSubscriberSchema),
  })
  .openapi("MailingListSubscribersResponse");

export const AddSubscribersRequestSchema = z
  .object({
    raw: z.string().min(1).openapi({
      description:
        "A pasted blob of email addresses. Comma-, semicolon-, tab- or newline-separated; `Name <email@example.com>` pairs are accepted. Duplicates and existing members are skipped, so re-pasting the same blob is a no-op.",
    }),
  })
  .openapi("AddSubscribersRequest");

export const AddSubscribersResponseSchema = z
  .object({
    slug: z.string(),
    added: z.array(z.string()).openapi({ description: "Addresses newly added to the list" }),
    skipped: z.array(z.string()).openapi({ description: "Addresses already on the list, or repeated inside the blob" }),
    rejected: z
      .array(z.object({ value: z.string(), reason: z.string() }))
      .openapi({ description: "Fragments that could not be read as an email address" }),
  })
  .openapi("AddSubscribersResponse");

export const RemoveSubscriberResponseSchema = z
  .object({
    slug: z.string(),
    email: z.string(),
    removed: z.boolean(),
  })
  .openapi("RemoveSubscriberResponse");

/**
 * An update body arrives one of two ways and never both.
 *
 * `body` is markdown this service renders — the composer path, unchanged.
 * `htmlBody` is a finished HTML document staff authored themselves, which no
 * markdown renderer can express: table layout, inline styles, hosted images, a
 * 600px shell of its own. It is sent exactly as supplied.
 *
 * Refusing "both" and "neither" loudly matters more here than it looks. Both
 * would make the service pick one silently, and the one it picked would be
 * discovered by tens of thousands of people reading the wrong email.
 */
const bodyKindRefinement = (
  value: { body?: string; htmlBody?: string; textBody?: string },
  ctx: { addIssue: (issue: { code: "custom"; path: string[]; message: string }) => void }
) => {
  if (value.body && value.htmlBody) {
    ctx.addIssue({
      code: "custom",
      path: ["htmlBody"],
      message:
        "State either `body` (markdown this service renders) or `htmlBody` (a document you authored), never both — there is no rule for which would win.",
    });
  }
  if (!value.body && !value.htmlBody) {
    ctx.addIssue({
      code: "custom",
      path: ["body"],
      message: "An update needs a body: `body` as markdown, or `htmlBody` as a document you authored.",
    });
  }
  if (value.textBody && !value.htmlBody) {
    ctx.addIssue({
      code: "custom",
      path: ["textBody"],
      message:
        "`textBody` belongs with `htmlBody` only. A markdown update sends the markdown itself as its text part, so a `textBody` beside `body` would be dropped without a word.",
    });
  }
};

export const SendUpdateRequestSchema = z
  .object({
    subject: z.string().min(1),
    body: z.string().min(1).optional().openapi({
      description:
        "The update body, authored as markdown — headings, bold, links, tables, and `![alt](https://…)` inline images. Rendered to HTML with all styling inlined on the elements (mail clients strip `<style>` and `<head>`); the markdown itself is sent as the plain-text part. SVG images are rejected with a 400 — Gmail, Outlook and Yahoo show the alt text instead of the image, so use PNG or JPEG. A discreet unsubscribe is appended downstream by email-gateway; do not add one here. Mutually exclusive with `htmlBody`; exactly one of the two is required.",
    }),
    htmlBody: z.string().min(1).optional().openapi({
      description:
        "A complete HTML document staff authored, sent to every recipient byte-for-byte as supplied: nothing is re-rendered, no styles are inlined for you, and it is not wrapped in the markdown template's shell. Use it for a designed newsletter — table layout, inline styles on every element, hosted PNG or JPEG images, a 600px measure — which markdown cannot express. Everything else applies unchanged: email-gateway appends the unsubscribe footer, suppressed members are skipped, one message goes per recipient, and `from` selects the sender. SVG images are still refused with a 400, since they arrive as broken placeholders whoever authored the markup. Mutually exclusive with `body`; exactly one of the two is required.",
    }),
    textBody: z.string().min(1).optional().openapi({
      description:
        "The plain-text part for an `htmlBody` send. Omit it and one is derived from the HTML — tags dropped, links kept as `label (url)` — so the message always carries a text alternative. Supply it to write better prose than a derivation gives. Only valid beside `htmlBody`: a markdown update's text part is its markdown.",
    }),
    from: z
      .string()
      .email()
      .optional()
      .openapi({
        description:
          "The address this update goes out from, for this send only. Omit it and the update leaves the investor-update sender, kevin@distribute.you, exactly as every update did before this field existed. State one to send from another identity — a newsletter leaving a dedicated subdomain, say. The address must be a sender Postmark has verified: an unverified one is refused by the provider and the whole send fails with its reason, never silently falling back to the default.",
      }),
  })
  .superRefine(bodyKindRefinement)
  .openapi("SendUpdateRequest");

export const PreviewUpdateRequestSchema = z
  .object({
    body: z.string().min(1).optional().openapi({
      description:
        "The update body as markdown, exactly as it would be sent. Rendered by the same code a real send uses. Mutually exclusive with `htmlBody`; exactly one of the two is required.",
    }),
    htmlBody: z.string().min(1).optional().openapi({
      description:
        "A document staff authored, previewed exactly as a send treats it: returned unchanged. Mutually exclusive with `body`.",
    }),
    textBody: z.string().min(1).optional().openapi({
      description:
        "The plain-text part for an `htmlBody` preview. Omit it and the derived one comes back, which is what a send with no `textBody` would use. Only valid beside `htmlBody`.",
    }),
  })
  .superRefine(bodyKindRefinement)
  .openapi("PreviewUpdateRequest");

export const PreviewUpdateResponseSchema = z
  .object({
    htmlBody: z.string().openapi({
      description:
        "The HTML a recipient would receive for this body, byte-for-byte what a send of the same body produces. email-gateway appends the unsubscribe footer at send time, so it is absent here. For an authored `htmlBody` this is that document unchanged.",
    }),
    textBody: z.string().openapi({
      description:
        "The plain-text part: the markdown itself for a markdown body, and for an authored one the supplied `textBody` or the text derived from the HTML.",
    }),
    bodyKind: z.enum(["markdown", "html"]).openapi({
      description: 'Which body this preview rendered: "markdown" was rendered by this service, "html" was returned as authored.',
    }),
    unrenderableImages: z.array(z.string()).openapi({
      description:
        "Image URLs no mail client renders. A send of this body would be refused with a 400 naming these; empty means the body is sendable.",
    }),
  })
  .openapi("PreviewUpdateResponse");

export const UpdateFailureSchema = z
  .object({
    email: z.string(),
    reason: z.string(),
  })
  .openapi("UpdateFailure");

export const SendUpdateResponseSchema = z
  .object({
    updateId: z.string(),
    slug: z.string(),
    subject: z.string(),
    status: z.enum(["sent", "partial", "failed"]).openapi({
      description:
        '"sent" — every recipient succeeded. "partial" — some did. "failed" — none did, which is answered with a 502 carrying the provider\'s reason.',
    }),
    from: z.string().openapi({ description: "The address the update went out from" }),
    recipientCount: z.number().openapi({ description: "Recipients the update actually reached" }),
    skippedOptedOut: z.array(z.string()).openapi({ description: "Members not mailed because the provider is suppressing them" }),
    failures: z.array(UpdateFailureSchema).openapi({ description: "Recipients whose send failed, with the provider's reason" }),
  })
  .openapi("SendUpdateResponse");

/** The 502 body when a send reached nobody: the outcome, plus the provider's reason. */
export const SendUpdateFailureResponseSchema = SendUpdateResponseSchema.extend({
  error: z.string().openapi({
    description: "The provider's own reason for refusing, verbatim — an unverified sender signature, say",
  }),
}).openapi("SendUpdateFailureResponse");

export const MailingListUpdateSchema = z
  .object({
    id: z.string(),
    subject: z.string(),
    body: z.string().nullable().openapi({
      description: "Markdown as authored, and null when the update was authored as HTML — there was no markdown",
    }),
    htmlBody: z.string().openapi({ description: "Body as sent" }),
    bodyKind: z.enum(["markdown", "html"]).openapi({
      description:
        'How this update was authored: "markdown" was rendered by this service, "html" was sent as the author wrote it.',
    }),
    status: z.enum(["sent", "partial", "failed"]),
    from: z.string().openapi({ description: "The address this update went out from" }),
    recipientCount: z.number(),
    failures: z.array(UpdateFailureSchema),
    sentAt: z.string().openapi({ format: "date-time" }),
  })
  .openapi("MailingListUpdate");

export const MailingListUpdatesResponseSchema = z
  .object({
    slug: z.string(),
    count: z.number(),
    updates: z.array(MailingListUpdateSchema),
  })
  .openapi("MailingListUpdatesResponse");

// --- Mailing-list releases (paced, staff-only) ---

/**
 * A release is the same update the synchronous send takes, plus the one thing
 * that route cannot express: how fast. Everything else is deliberately
 * identical, so an author who has approved a body in the preview is approving
 * the same bytes either way.
 */
export const CreateReleaseRequestSchema = z
  .object({
    subject: z.string().min(1),
    body: z.string().min(1).optional().openapi({
      description:
        "The update body, authored as markdown, rendered here exactly as the synchronous send renders it. Mutually exclusive with `htmlBody`; exactly one of the two is required.",
    }),
    htmlBody: z.string().min(1).optional().openapi({
      description:
        "A complete HTML document staff authored, sent to every recipient byte-for-byte as supplied. Mutually exclusive with `body`; exactly one of the two is required.",
    }),
    textBody: z.string().min(1).optional().openapi({
      description:
        "The plain-text part for an `htmlBody` release. Omit it and one is derived from the HTML. Only valid beside `htmlBody`.",
    }),
    from: z.string().email().optional().openapi({
      description:
        "The address this release goes out from. Omit it and it leaves kevin@distribute.you, the same default the synchronous send takes. It must be a sender Postmark has verified: an unverified one is refused by the provider, and every message in the release fails with its reason rather than falling back to anything.",
    }),
    dailyLimit: z.number().int().min(1).max(MAX_DAILY_LIMIT).openapi({
      description:
        "The most messages this release may send per UTC calendar day. Required, with no default: the pace is the reason a release exists and this service will not pick one on staff's behalf. The day's allowance is spread across the day rather than spent at midnight, and a day where the allowance is reached simply stops until the next one. The ceiling is " +
        `${MAX_DAILY_LIMIT}` +
        ", which is the most the worker's own pace can deliver in a day; a larger number is refused rather than silently under-delivered. Pick it for the sending reputation you have, not the list you hold: a subdomain two weeks old with a few hundred messages of lifetime volume is throttled or foldered by Gmail and Outlook if it jumps to tens of thousands.",
    }),
  })
  .superRefine(bodyKindRefinement)
  .openapi("CreateReleaseRequest");

/**
 * Changing the pace of a release that is already under way.
 *
 * The same number the create route takes, under the same ceiling, because it is
 * the same promise to the worker: a pace stated above what the worker can
 * deliver in a day would be accepted and then quietly missed every day. There
 * is no other field — a release's content, its list and the identity it sends
 * under are fixed at creation, and the pace is the one decision that is honestly
 * made on evidence the release itself produces.
 */
export const UpdateReleasePaceRequestSchema = z
  .object({
    dailyLimit: z.number().int().min(1).max(MAX_DAILY_LIMIT).openapi({
      description:
        "The new most-messages-per-UTC-day for this release, governing from the moment it is accepted. Raising it makes more of today's allowance available at once, without waiting for tomorrow. Lowering it below what today has already sent claws nothing back and fails nothing: the day simply rests and the new pace governs from the next one. The ceiling is " +
        `${MAX_DAILY_LIMIT}` +
        ", the same one the create route applies, for the same reason.",
    }),
  })
  .openapi("UpdateReleasePaceRequest");

export const ReleaseSchema = z
  .object({
    releaseId: z.string(),
    slug: z.string(),
    subject: z.string(),
    from: z.string(),
    bodyKind: z.enum(["markdown", "html"]),
    status: z.enum(["running", "paused", "cancelled", "halted", "completed"]).openapi({
      description:
        '"running" — the worker is releasing it. "paused" — staff stopped it and may resume. "cancelled" — staff ended it; it never resumes. "halted" — it stopped itself because the provider\'s delivery outcomes for it went bad, and staff were told. "completed" — every address is accounted for.',
    }),
    haltedReason: z.string().nullable().openapi({
      description: "Why a halted release stopped, in the words the staff alert repeated. Null otherwise.",
    }),
    dailyLimit: z.number(),
    recipientCount: z.number().openapi({ description: "Addresses the list held when the release was created" }),
    reached: z.number().openapi({ description: "Addresses a message has gone out to" }),
    remaining: z.number().openapi({ description: "Addresses still waiting" }),
    failed: z.number().openapi({ description: "Addresses whose send failed, or whose claim outlived the worker holding it" }),
    skippedOptedOut: z.number().openapi({
      description: "Addresses the provider was suppressing at the moment their slice was sent — checked per slice, so somebody who unsubscribes on day one is skipped on day five",
    }),
    inFlight: z.number().openapi({ description: "Addresses a worker is holding right now" }),
    todayAllowance: z.number().openapi({ description: "Messages this release may send today: its daily limit" }),
    todayUsed: z.number().openapi({ description: "How much of today's allowance is spent, in-flight addresses included" }),
    estimatedDaysRemaining: z.number().openapi({
      description:
        "How many more UTC days the addresses still waiting need at the release's current pace, today included when today can still carry somebody. 0 when nobody is waiting, and 0 for a release that is not going to run again. It is arithmetic over the pace and the ledger: it says nothing about the provider's outcomes.",
    }),
    nextSliceSize: z.number().openapi({
      description: "How many the next tick would take, which is 0 when today's allowance is spent or the release is not running",
    }),
    createdAt: z.string().openapi({ format: "date-time" }),
    completedAt: z.string().nullable().openapi({ format: "date-time" }),
  })
  .openapi("MailingListRelease");

export const CreateReleaseResponseSchema = ReleaseSchema.extend({
  created: z.boolean().openapi({
    description:
      "False when this request restated an update already being released to this list, in which case the release the first request created is returned untouched and nothing new was started.",
  }),
  estimatedDays: z.number().openapi({ description: "recipientCount divided by dailyLimit, rounded up" }),
}).openapi("CreateReleaseResponse");

export const ReleasesResponseSchema = z
  .object({
    slug: z.string(),
    count: z.number(),
    releases: z.array(ReleaseSchema),
  })
  .openapi("ReleasesResponse");

export const ReleaseTickResponseSchema = z
  .object({
    releasesConsidered: z.number(),
    sent: z.number(),
    failed: z.number(),
    skippedOptedOut: z.number(),
    completed: z.array(z.string()),
    halted: z.array(z.string()),
    skippedBusy: z.boolean().openapi({
      description: "True when another tick was already running and this call did nothing",
    }),
  })
  .openapi("ReleaseTickResponse");

// --- Shared header parameters ---

const orgIdHeader = {
  name: "x-org-id",
  in: "header" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Internal org UUID from client-service",
};

const userIdHeader = {
  name: "x-user-id",
  in: "header" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Internal user UUID from client-service",
};

const runIdHeader = {
  name: "x-run-id",
  in: "header" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Caller's run ID",
};

const campaignIdHeader = {
  name: "x-campaign-id",
  in: "header" as const,
  required: false,
  schema: { type: "string" as const },
  description: "Campaign ID (injected automatically by workflow-service)",
};

const brandIdHeader = {
  name: "x-brand-id",
  in: "header" as const,
  required: false,
  schema: { type: "string" as const },
  description: "Comma-separated brand IDs (e.g. \"uuid1,uuid2,uuid3\"). Injected automatically by workflow-service. Single UUID for single-brand campaigns.",
};

const workflowSlugHeader = {
  name: "x-workflow-slug",
  in: "header" as const,
  required: false,
  schema: { type: "string" as const },
  description: "Workflow slug (injected automatically by workflow-service)",
};

const featureSlugHeader = {
  name: "x-feature-slug",
  in: "header" as const,
  required: false,
  schema: { type: "string" as const },
  description: "Feature slug for tracking which feature triggered the request",
};

// --- Register endpoints ---

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  description: "Returns service health status",
  tags: ["Health"],
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/send",
  summary: "Send a lifecycle email",
  description:
    "Send a templated lifecycle email. Resolves recipients via user ID (client-service) or direct email. " +
    "One of userId (from x-user-id header) or recipientEmail is required.\n\n" +
    "**Required headers:** `x-org-id`, `x-user-id`, `x-run-id`\n\n" +
    "**Deduplication:** The dedup strategy depends on eventType:\n" +
    "- **Once-only** (waitlist, welcome, signup_notification): sent at most once per recipient, ever. Dedup key: `{orgId}:{eventType}:{userId or recipientEmail}`.\n" +
    "- **Daily** (user_active): sent at most once per recipient per day. Dedup key: `{orgId}:{eventType}:{identifier}:{YYYY-MM-DD}`.\n" +
    "- **Product-scoped** (webinar_welcome, j_minus_3, j_minus_2, j_minus_1, j_day): sent once per recipient per productId. Dedup key: `{orgId}:{eventType}:{recipientEmail}:{productId}`.\n" +
    "- **Monthly per-brand** (audience_fully_contacted): sent at most once per org per brand per calendar month. Brand + month derive from the existing request (x-brand-id header / brandIds body). Dedup key: `{orgId}:{eventType}:{sortedBrandIds}:{YYYY-MM}`.\n" +
    "- **Org-daily** (provider_credits_exhausted): sent at most once per org per calendar day. No recipient and no user in the key, so a machine caller deduplicates exactly like one with an acting user. Dedup key: `{orgId}:{eventType}:{YYYY-MM-DD}`.\n" +
    "- **No dedup** (all other event types, including brand_daily_budget_changed, payment_method_removed, staff_daily_digest and unpaid_debt_uncollectable): sends every time with no dedup.\n\n" +
    "**Staff routing:** `signup_notification`, `signin_notification`, `user_active`, `brand_daily_budget_changed`, `payment_method_removed`, `staff_daily_digest`, `provider_credits_exhausted` and `unpaid_debt_uncollectable` (billing-service: an org owes money and has no card to collect it on) are delivered to the internal staff recipient list instead of the customer resolved from `x-user-id`. Their metadata is enriched with the acting user's email under `email` when not already supplied — a caller with no acting user sends no actor metadata at all.\n\n" +
    "**`provider_credits_exhausted`** reports that a paid third-party provider has run out of credits, so work depending on it now produces nothing. `metadata.provider` (which provider) and `metadata.reason` (why we concluded it is dry) are required and must be non-empty; `metadata.detail` carries any raw upstream status or response body and is optional. `metadata.orgId` is filled in from `x-org-id` and needs no supplying. It accepts no `recipientEmail`, no `bccEmails` and no `ccEmails` on any route, so it cannot reach a customer address.\n\n" +
    "`bccEmails` are delivered as provider-level BCC recipients on the primary email, and `ccEmails` as provider-level Cc recipients. Neither is rendered into templates and neither affects primary-recipient deduplication.\n\n" +
    "**Visible copy:** `ccEmails` puts an address on the Cc header, where every recipient of the message can see it and a reply-all reaches it — the right instrument when somebody is a party to the conversation rather than an observer of it. Nothing is ever added to this list: a caller that names none gets a message with no Cc at all, byte for byte as before. It is refused on the same staff-routed events that refuse `recipientEmail` and `bccEmails`.\n\n" +
    "**Blind copy and replies:** a customer-facing send is blind-copied to kevin@distribute.you, so the company sees what it tells a customer as it tells them. A caller's own `bccEmails` are kept and that one address is added to them, never in place of them. A staff-routed event carries no such blind copy — the same person is already a primary recipient on the staff list, and a second copy would deliver the message twice. Every send, staff or customer, invites replies to kevin@distribute.you so a customer who hits reply reaches a human.\n\n" +
    "Duplicate sends return `{ sent: false, reason: 'duplicate' }`. To add a new event type to dedup, add it to the corresponding set in send.ts.",
  tags: ["Email"],
  security: [{ apiKey: [] }],
  parameters: [orgIdHeader, userIdHeader, runIdHeader, campaignIdHeader, brandIdHeader, workflowSlugHeader, featureSlugHeader],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SendRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Email send results",
      content: { "application/json": { schema: SendResponseSchema } },
    },
    400: {
      description: "Validation error or missing identity headers",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized - invalid or missing API key",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/platform-send",
  summary: "Send a staff-bound notification without an acting user",
  description:
    "For machine callers that hold an organisation and an API key but no end-user identity — e.g. stripe-service reacting to a Stripe webhook, where the customer acted inside Stripe's billing portal and no user of ours took any action.\n\n" +
    "**Required headers:** `x-org-id`. `x-user-id` and `x-run-id` are honoured when present but never required, and are never substituted with a placeholder when absent.\n\n" +
    "**Accepted event types:** staff-bound events only (`signup_notification`, `signin_notification`, `user_active`, `brand_daily_budget_changed`, `payment_method_removed`, `staff_daily_digest`, `provider_credits_exhausted`). Any other event type is rejected with 400, so no request on this path can reach a customer.\n\n" +
    "`recipientEmail`, `bccEmails` and `ccEmails` are rejected with 400: delivery is to the internal staff recipient list only.\n\n" +
    "**`provider_credits_exhausted`** — the event type a backend service raises when it detects that a paid third-party provider has run out of credits (e.g. apollo-service on Apollo.io credit exhaustion). Send it here: an org and an API key are enough, no acting user is needed.\n\n" +
    "```json\n" +
    "{\n" +
    "  \"eventType\": \"provider_credits_exhausted\",\n" +
    "  \"metadata\": {\n" +
    "    \"provider\": \"Apollo.io\",\n" +
    "    \"reason\": \"people/search returned 402 with credits_remaining: 0 on 3 consecutive calls\",\n" +
    "    \"detail\": \"HTTP 402 {\\\"error\\\":\\\"insufficient_credits\\\",\\\"credits_remaining\\\":0}\"\n" +
    "  }\n" +
    "}\n" +
    "```\n\n" +
    "`metadata.provider` and `metadata.reason` are required and must be non-empty, else 400 — a staff alert with blanks where the facts belong is not actionable. `metadata.detail` is optional free-form room for the raw upstream status or response body. `metadata.orgId` is filled in from `x-org-id`. It is deduped once per org per calendar day (key `{orgId}:provider_credits_exhausted:{YYYY-MM-DD}`), so a service hitting the credit wall on thousands of consecutive operations mails staff once; the repeats return `{ sent: false, reason: \"duplicate\" }` like any other deduplicated send, and the next calendar day the alert can raise again. Its template is registered by this service on boot, not by the caller.\n\n" +
    "Dedup, template resolution, run tracking and response shape are identical to `POST /send`. `payment_method_removed` and `staff_daily_digest` belong to no dedup set, so every occurrence sends. The `staff_daily_digest` template is owned and registered by the customer dashboard under that exact name.",
  tags: ["Email"],
  security: [{ apiKey: [] }],
  parameters: [
    orgIdHeader,
    { ...userIdHeader, required: false, description: "Internal user UUID from client-service. Optional on this route — omit it when there is no acting user." },
    { ...runIdHeader, required: false, description: "Caller's run ID. Optional on this route — omit it when there is no parent run." },
    campaignIdHeader,
    brandIdHeader,
    workflowSlugHeader,
    featureSlugHeader,
  ],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SendRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Email send results",
      content: { "application/json": { schema: SendResponseSchema } },
    },
    400: {
      description: "Validation error, missing x-org-id, non-staff event type, or recipientEmail/bccEmails/ccEmails supplied",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized - invalid or missing API key",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/stats",
  summary: "Get aggregated stats",
  description:
    "Get aggregated email event stats scoped by the caller's org (from x-org-id header), with optional eventType filter as query param.\n\n" +
    "**Required headers:** `x-org-id`, `x-user-id`, `x-run-id`",
  tags: ["Stats"],
  security: [{ apiKey: [] }],
  parameters: [
    orgIdHeader,
    userIdHeader,
    runIdHeader,
    campaignIdHeader,
    brandIdHeader,
    workflowSlugHeader,
    { name: "eventType", in: "query", required: false, schema: { type: "string" } },
  ],
  responses: {
    200: {
      description: "Aggregated stats",
      content: { "application/json": { schema: StatsResponseSchema } },
    },
    400: {
      description: "Validation error or missing identity headers",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized - invalid or missing API key",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/templates",
  summary: "Deploy (upsert) email templates",
  description:
    "Idempotent: creates new templates or updates existing ones matched by name. Call this at app startup to register all your email templates. Templates support {{variable}} interpolation from metadata passed at send time.\n\n" +
    "**Required headers:** `x-org-id`, `x-user-id`, `x-run-id`",
  tags: ["Templates"],
  security: [{ apiKey: [] }],
  parameters: [orgIdHeader, userIdHeader, runIdHeader, campaignIdHeader, brandIdHeader, workflowSlugHeader, featureSlugHeader],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: DeployTemplatesRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Templates deployed",
      content: { "application/json": { schema: DeployTemplatesResponseSchema } },
    },
    400: {
      description: "Validation error or missing identity headers",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized - invalid or missing API key",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Transfer brand ownership between orgs (solo-brand only)",
  description:
    "Re-assigns email_events rows from sourceOrgId to targetOrgId for a given sourceBrandId. " +
    "Only updates rows where brand_ids contains exactly one element matching sourceBrandId (solo-brand). " +
    "When targetBrandId is provided, also rewrites the brand reference to the target brand. " +
    "Rows with multiple brand IDs (co-branding) are skipped. Idempotent — running twice is a no-op.",
  tags: ["Internal"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: TransferBrandRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Transfer results per table",
      content: { "application/json": { schema: TransferBrandResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized - invalid or missing API key",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Mailing lists ---

const mailingListSlugParam = {
  name: "slug",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "List slug, e.g. \"investors\". Lower-case letters, digits and hyphens.",
};

const releaseIdParam = {
  name: "releaseId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const, format: "uuid" as const },
  description: "The release's id, as returned when it was created.",
};

const platformOrgIdHeader = {
  ...orgIdHeader,
  description:
    "Internal org UUID used as the SENDING identity only (Postmark key + from-address resolution). Mailing lists are platform-level and are never filtered by organisation.",
};

const staffUserIdHeader = {
  ...userIdHeader,
  description:
    "Internal user UUID of the acting staff member. Required: key-service resolves the Postmark token and stream against a user, and a send is billed to this user's organisation.",
};

const mailingListsDescription =
  "Staff-only. Mailing lists are platform-level (org-less) lists of bare email addresses. " +
  "Opt-out state is never stored here: Postmark's broadcast stream owns the suppression list, " +
  "and every read reconciles against it — asking Postmark only about the addresses on the list, " +
  "and reusing an answer for at most a minute. A send reconciles with no reuse at all.";

registry.registerPath({
  method: "get",
  path: "/mailing-lists/{slug}/subscribers",
  summary: "Read a mailing list",
  description: `${mailingListsDescription} Each entry states whether the provider is currently suppressing it.`,
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ slug: z.string() }) },
  parameters: [mailingListSlugParam, platformOrgIdHeader, staffUserIdHeader],
  responses: {
    200: {
      description: "Subscribers with live opt-out state",
      content: { "application/json": { schema: MailingListSubscribersResponseSchema } },
    },
    400: { description: "Invalid slug or missing x-org-id", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such list", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "Provider suppression state unavailable", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/mailing-lists/{slug}/subscribers",
  summary: "Add addresses in bulk from a pasted blob",
  description:
    `${mailingListsDescription} Parses the blob leniently and reports what was added, skipped and rejected. ` +
    "Creates the list on first use. Re-pasting the same blob is a no-op.",
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ slug: z.string() }),
    body: { required: true, content: { "application/json": { schema: AddSubscribersRequestSchema } } },
  },
  parameters: [mailingListSlugParam, platformOrgIdHeader, staffUserIdHeader],
  responses: {
    200: { description: "Add results", content: { "application/json": { schema: AddSubscribersResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/mailing-lists/{slug}/subscribers",
  summary: "Remove an address from a mailing list",
  description: mailingListsDescription,
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ slug: z.string() }), query: z.object({ email: z.string() }) },
  parameters: [mailingListSlugParam, platformOrgIdHeader, staffUserIdHeader],
  responses: {
    200: { description: "Removed", content: { "application/json": { schema: RemoveSubscriberResponseSchema } } },
    400: { description: "Invalid slug or missing email", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such list, or the address is not on it", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/mailing-lists/updates/preview",
  summary: "Render an update body exactly as a recipient would receive it",
  description:
    `${mailingListsDescription} Renders a draft body and returns nothing else: no message is sent, no update is ` +
    "recorded, no suppression state is read. The rendering is the same code path a real send uses, so an author " +
    "approving this preview is approving what lands in the inbox. It takes no list, because the body renders the " +
    "same whoever receives it. A body authored as HTML (`htmlBody`) comes back unchanged, which is also what a send " +
    "does with it.",
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: PreviewUpdateRequestSchema } } },
  },
  parameters: [platformOrgIdHeader],
  responses: {
    200: { description: "The body as it would arrive", content: { "application/json": { schema: PreviewUpdateResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/mailing-lists/{slug}/updates",
  summary: "Send a written update to a mailing list",
  description:
    `${mailingListsDescription} The caller supplies the subject and exactly one body: \`body\` as markdown ` +
    "(inline images supported), which this service renders to HTML, or `htmlBody` as a complete document the staff " +
    "author wrote, which goes out byte-for-byte as supplied with a text part supplied or derived. Stating both, or " +
    "neither, is refused with a 400. One message is sent per recipient, so no recipient is visible to another. " +
    "Members the provider is suppressing are skipped. A partial failure is reported as `partial` with the failing " +
    "addresses and reasons, never as a clean success. The sender defaults to the investor-update address and can be " +
    "stated per send with `from`; a sender the provider has not verified fails the send with a 502 carrying the " +
    "provider's reason, and is never retried onto the default.",
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ slug: z.string() }),
    body: { required: true, content: { "application/json": { schema: SendUpdateRequestSchema } } },
  },
  parameters: [mailingListSlugParam, platformOrgIdHeader, staffUserIdHeader],
  responses: {
    200: { description: "Send outcome", content: { "application/json": { schema: SendUpdateResponseSchema } } },
    400: { description: "Validation error, an SVG image no mail client renders, empty list, or every subscriber opted out", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such list", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: {
      description:
        "Not one recipient was reached — an unverified sender, say. Carries the provider's reason and the recorded update, which is stored as `failed`.",
      content: { "application/json": { schema: SendUpdateFailureResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/mailing-lists/{slug}/updates",
  summary: "Read the history of updates sent to a mailing list",
  description: `${mailingListsDescription} Returns every update with its subject, the body as sent, when it went out, and how many people it reached.`,
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ slug: z.string() }) },
  parameters: [mailingListSlugParam, platformOrgIdHeader, staffUserIdHeader],
  responses: {
    200: { description: "Update history, newest first", content: { "application/json": { schema: MailingListUpdatesResponseSchema } } },
    400: { description: "Invalid slug or missing x-org-id", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such list", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const releasesDescription =
  "Staff-only. A release sends one written update to a mailing list over several days at a stated daily pace. " +
  "Nothing is sent inside the request that creates it: an in-process worker releases it afterwards, so no caller " +
  "holds a connection open and a restart changes nothing. Every address is a ledger row from the moment the " +
  "release is created, which is what makes never mailing anybody twice structural rather than careful, and what " +
  "progress is counted from. Provider suppression is re-read for each slice at the moment that slice is sent.";

registry.registerPath({
  method: "post",
  path: "/mailing-lists/{slug}/releases",
  summary: "Release a written update to a mailing list over several days",
  description:
    `${releasesDescription} The body is stated exactly as the synchronous send takes it — \`body\` as markdown or ` +
    "`htmlBody` as a document staff authored — plus `dailyLimit`, which has no default. The answer comes back in " +
    "about a second whatever the list's size and reports how many recipients the release covers and the pace it " +
    "will follow. Restating an update already being released to this list returns that release with " +
    "`created: false` rather than starting a second one over the same people.",
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ slug: z.string() }),
    body: { required: true, content: { "application/json": { schema: CreateReleaseRequestSchema } } },
  },
  parameters: [mailingListSlugParam, platformOrgIdHeader, staffUserIdHeader],
  responses: {
    201: { description: "The release, newly created", content: { "application/json": { schema: CreateReleaseResponseSchema } } },
    200: { description: "This update is already being released to this list; the existing release is returned", content: { "application/json": { schema: CreateReleaseResponseSchema } } },
    400: { description: "Validation error, an SVG image no mail client renders, or an empty list", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such list", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "The release could not be tracked, so it was not started", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/mailing-lists/{slug}/releases",
  summary: "Every release created for a mailing list",
  description: `${releasesDescription} Newest first, each with its progress.`,
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ slug: z.string() }) },
  parameters: [mailingListSlugParam, platformOrgIdHeader, staffUserIdHeader],
  responses: {
    200: { description: "Releases, newest first", content: { "application/json": { schema: ReleasesResponseSchema } } },
    400: { description: "Invalid slug or missing x-org-id", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such list", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/mailing-lists/releases/{releaseId}",
  summary: "Where one release stands",
  description:
    `${releasesDescription} Reports reached, remaining, failed and skipped, plus today's allowance and how much of ` +
    "it is spent. Counted from the ledger, so a redeploy does not change the answer.",
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ releaseId: z.string() }) },
  parameters: [releaseIdParam, platformOrgIdHeader],
  responses: {
    200: { description: "The release and its progress", content: { "application/json": { schema: ReleaseSchema } } },
    400: { description: "Invalid release id or missing x-org-id", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such release", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/mailing-lists/releases/{releaseId}/pause",
  summary: "Stop a running release",
  description:
    `${releasesDescription} It stops within one tick and sends nothing further until it is resumed. Addresses ` +
    "already reached stay reached; nobody is sent to twice when it resumes.",
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ releaseId: z.string() }) },
  parameters: [releaseIdParam, platformOrgIdHeader],
  responses: {
    200: { description: "The paused release", content: { "application/json": { schema: ReleaseSchema } } },
    400: { description: "Invalid release id or missing x-org-id", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such release", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "The release is not running", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/mailing-lists/releases/{releaseId}/resume",
  summary: "Continue a paused release where it stopped",
  description:
    `${releasesDescription} Only a paused release resumes. A cancelled one never does, and one that stopped itself ` +
    "on the provider's delivery outcomes does not either — sending the same update again is a new release, so that " +
    "the decision is made rather than undone.",
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ releaseId: z.string() }) },
  parameters: [releaseIdParam, platformOrgIdHeader],
  responses: {
    200: { description: "The running release", content: { "application/json": { schema: ReleaseSchema } } },
    400: { description: "Invalid release id or missing x-org-id", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such release", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "The release is not paused", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/mailing-lists/releases/{releaseId}/pace",
  summary: "Change how fast a release goes out, while it is going out",
  description:
    `${releasesDescription} The pace a release was created with is a guess made before the first message went out; ` +
    "this changes it on the evidence the release has since produced. It governs from the moment it is accepted: " +
    "raising it lets more go out the same day, up to the new allowance, and lowering it below what the day has " +
    "already sent claws nothing back and fails nothing — the day rests and the new pace governs from the next one. " +
    "Nobody already reached is mailed again and nobody waiting is dropped, because the ledger is untouched. Only a " +
    "running or paused release takes a new pace: one that completed, was cancelled, or stopped itself on the " +
    "provider's delivery outcomes is refused, and the refusal says which it is.",
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ releaseId: z.string() }),
    body: { required: true, content: { "application/json": { schema: UpdateReleasePaceRequestSchema } } },
  },
  parameters: [releaseIdParam, platformOrgIdHeader, staffUserIdHeader],
  responses: {
    200: { description: "The release at its new pace, with a revised estimate of how long it has left", content: { "application/json": { schema: ReleaseSchema } } },
    400: { description: "Invalid release id, missing x-org-id, or a pace the worker cannot deliver", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such release", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "The release has ended or stopped itself, and its decision stands", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/mailing-lists/releases/{releaseId}/cancel",
  summary: "End a release; it never resumes",
  description:
    `${releasesDescription} Every address still waiting is settled as cancelled, so the ledger states what happened ` +
    "to all of them rather than implying they are still queued.",
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ releaseId: z.string() }) },
  parameters: [releaseIdParam, platformOrgIdHeader],
  responses: {
    200: { description: "The cancelled release", content: { "application/json": { schema: ReleaseSchema } } },
    400: { description: "Invalid release id or missing x-org-id", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No such release", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "The release has already ended", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/mailing-lists/releases/tick",
  summary: "Run one pass of the release worker",
  description:
    "Runs one pass over every running release and reports what it did. The worker already runs on its own interval " +
    "inside the service, which is what paces a release; this route exists so a cron can act as a backstop for a " +
    "process that died, and so a caller can drive the pace without waiting on a clock. Safe to call at any time: " +
    "two ticks never overlap, and a call that arrives while one is running answers `skippedBusy`.",
  tags: ["Mailing lists"],
  security: [{ apiKey: [] }],
  responses: {
    200: { description: "What the tick did", content: { "application/json": { schema: ReleaseTickResponseSchema } } },
    401: { description: "Unauthorized - invalid or missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  summary: "OpenAPI specification",
  description: "Returns the OpenAPI spec for this service",
  tags: ["Docs"],
  responses: {
    200: { description: "OpenAPI JSON document" },
    404: {
      description: "Spec not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
