import { z } from "zod";
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
        "Any other event type has NO dedup and will send every time. " +
        "Staff notification events (signup_notification, signin_notification, user_active, brand_daily_budget_changed, payment_method_removed) are delivered to the internal staff recipient list, never to the customer.",
    }),
    brandIds: z.array(z.string()).optional().openapi({ description: "Brand IDs for tracking (one or more UUIDs)" }),
    campaignId: z.string().optional().openapi({ description: "Campaign ID for tracking" }),
    productId: z.string().optional().openapi({ description: "Product/instance ID, required for product-scoped dedup (e.g. webinar ID)" }),
    recipientEmail: z.string().email().optional().openapi({ description: "Direct recipient email (overrides client-service resolution if provided)" }),
    bccEmails: z.array(z.string().email()).optional().openapi({
      description:
        "Blind-copy recipient email addresses. These are forwarded as provider-level BCC recipients and are not rendered into templates or stored in metadata.",
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

export const SendUpdateRequestSchema = z
  .object({
    subject: z.string().min(1),
    body: z.string().min(1).openapi({
      description:
        "The update body, authored as markdown — headings, bold, links, tables, and `![alt](https://…)` inline images. Rendered to HTML with all styling inlined on the elements (mail clients strip `<style>` and `<head>`); the markdown itself is sent as the plain-text part. SVG images are rejected with a 400 — Gmail, Outlook and Yahoo show the alt text instead of the image, so use PNG or JPEG. A discreet unsubscribe is appended downstream by email-gateway; do not add one here.",
    }),
  })
  .openapi("SendUpdateRequest");

export const PreviewUpdateRequestSchema = z
  .object({
    body: z.string().min(1).openapi({
      description:
        "The update body as markdown, exactly as it would be sent. Rendered by the same code a real send uses.",
    }),
  })
  .openapi("PreviewUpdateRequest");

export const PreviewUpdateResponseSchema = z
  .object({
    htmlBody: z.string().openapi({
      description:
        "The HTML a recipient would receive for this body, byte-for-byte what a send of the same body produces. email-gateway appends the unsubscribe footer at send time, so it is absent here.",
    }),
    textBody: z.string().openapi({ description: "The plain-text part, which is the markdown itself" }),
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
    status: z.enum(["sent", "partial"]),
    recipientCount: z.number().openapi({ description: "Recipients the update actually reached" }),
    skippedOptedOut: z.array(z.string()).openapi({ description: "Members not mailed because the provider is suppressing them" }),
    failures: z.array(UpdateFailureSchema).openapi({ description: "Recipients whose send failed, with the provider's reason" }),
  })
  .openapi("SendUpdateResponse");

export const MailingListUpdateSchema = z
  .object({
    id: z.string(),
    subject: z.string(),
    body: z.string().openapi({ description: "Markdown as authored" }),
    htmlBody: z.string().openapi({ description: "Body as sent" }),
    status: z.enum(["sent", "partial"]),
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
    "- **No dedup** (all other event types, including brand_daily_budget_changed and payment_method_removed): sends every time with no dedup.\n\n" +
    "**Staff routing:** `signup_notification`, `signin_notification`, `user_active`, `brand_daily_budget_changed` and `payment_method_removed` are delivered to the internal staff recipient list instead of the customer resolved from `x-user-id`. Their metadata is enriched with the acting user's email under `email` when not already supplied — a caller with no acting user sends no actor metadata at all.\n\n" +
    "`bccEmails` are delivered as provider-level BCC recipients on the primary email. They are not rendered into templates and do not affect primary-recipient deduplication.\n\n" +
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
    "**Accepted event types:** staff-bound events only (`signup_notification`, `signin_notification`, `user_active`, `brand_daily_budget_changed`, `payment_method_removed`). Any other event type is rejected with 400, so no request on this path can reach a customer.\n\n" +
    "`recipientEmail` and `bccEmails` are rejected with 400: delivery is to the internal staff recipient list only.\n\n" +
    "Dedup, template resolution, run tracking and response shape are identical to `POST /send`. `payment_method_removed` belongs to no dedup set, so every occurrence sends.",
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
      description: "Validation error, missing x-org-id, non-staff event type, or recipientEmail/bccEmails supplied",
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
    "same whoever receives it.",
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
    `${mailingListsDescription} The caller supplies the subject and a markdown body (inline images supported); ` +
    "recipients receive it as HTML. One message is sent per recipient, so no recipient is visible to another. " +
    "Members the provider is suppressing are skipped. A partial failure is reported as `partial` with the failing " +
    "addresses and reasons, never as a clean success.",
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
