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
    appId: z.string().openapi({ description: "App identifier (e.g. 'mcpfactory'). Must match a registered template app." }),
    eventType: z.string().openapi({
      description:
        "Event type determining which template to use and which dedup strategy applies. " +
        "Once-only events (waitlist, welcome, signup_notification): sent at most once per recipient. " +
        "Daily events (user_active): sent at most once per recipient per day. " +
        "Product-scoped events (webinar_welcome, j_minus_3, j_minus_2, j_minus_1, j_day): sent once per recipient per productId. " +
        "Any other event type has NO dedup and will send every time.",
    }),
    brandId: z.string().optional().openapi({ description: "Brand ID for tracking" }),
    campaignId: z.string().optional().openapi({ description: "Campaign ID for tracking" }),
    productId: z.string().optional().openapi({ description: "Product/instance ID, required for product-scoped dedup (e.g. webinar ID)" }),
    userId: z.string().openapi({ description: "Internal user ID (client-service UUID) — used to resolve recipient email and for run/cost tracking" }),
    orgId: z.string().openapi({ description: "Internal org ID (client-service UUID) — used for run/cost tracking" }),
    recipientEmail: z.string().email().optional().openapi({ description: "Direct recipient email (fallback when no userId provided)" }),
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

// --- POST /stats ---

export const StatsRequestSchema = z
  .object({
    appId: z.string().optional(),
    orgId: z.string().optional(),
    userId: z.string().optional(),
    eventType: z.string().optional(),
  })
  .openapi("StatsRequest");

export type StatsRequest = z.infer<typeof StatsRequestSchema>;

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
    appId: z.string().min(1),
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
    "One of userId or recipientEmail is required.\n\n" +
    "**Deduplication:** The dedup strategy depends on eventType:\n" +
    "- **Once-only** (waitlist, welcome, signup_notification): sent at most once per recipient, ever. Dedup key: `{appId}:{eventType}:{userId or recipientEmail}`.\n" +
    "- **Daily** (user_active): sent at most once per recipient per day. Dedup key: `{appId}:{eventType}:{identifier}:{YYYY-MM-DD}`.\n" +
    "- **Product-scoped** (webinar_welcome, j_minus_3, j_minus_2, j_minus_1, j_day): sent once per recipient per productId. Dedup key: `{appId}:{eventType}:{recipientEmail}:{productId}`.\n" +
    "- **No dedup** (all other event types): sends every time with no dedup.\n\n" +
    "Duplicate sends return `{ sent: false, reason: 'duplicate' }`. To add a new event type to dedup, add it to the corresponding set in send.ts.",
  tags: ["Email"],
  security: [{ apiKey: [] }],
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
      description: "Validation error",
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
  path: "/stats",
  summary: "Get aggregated stats",
  description:
    "Get aggregated email event stats filtered by appId, orgId, userId, and/or eventType. At least one filter required.",
  tags: ["Stats"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: StatsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Aggregated stats",
      content: { "application/json": { schema: StatsResponseSchema } },
    },
    400: {
      description: "Validation error or missing filters",
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
    "Idempotent: creates new templates or updates existing ones matched by (appId + name). Call this at app startup to register all your email templates. Templates support {{variable}} interpolation from metadata passed at send time.",
  tags: ["Templates"],
  security: [{ apiKey: [] }],
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
      description: "Validation error",
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
