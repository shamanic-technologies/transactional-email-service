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
        "Any other event type has NO dedup and will send every time.",
    }),
    brandIds: z.array(z.string()).optional().openapi({ description: "Brand IDs for tracking (one or more UUIDs)" }),
    campaignId: z.string().optional().openapi({ description: "Campaign ID for tracking" }),
    productId: z.string().optional().openapi({ description: "Product/instance ID, required for product-scoped dedup (e.g. webinar ID)" }),
    recipientEmail: z.string().email().optional().openapi({ description: "Direct recipient email (overrides client-service resolution if provided)" }),
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
    "- **No dedup** (all other event types): sends every time with no dedup.\n\n" +
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
