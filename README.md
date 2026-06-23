# Transactional Email Service

Transactional email service that sends event-triggered emails. Resolves recipients via client-service, deduplicates sends, renders HTML/text templates, and delivers via the Email Gateway.

## API

All protected endpoints require these headers:
- `x-api-key` — service API key
- `x-org-id` — internal org UUID from client-service
- `x-user-id` — internal user UUID from client-service
- `x-run-id` — caller's run ID

**Platform endpoints** (`/platform-*`) only require `x-api-key` — no identity headers. Use these for cold-start deployment without a user session.

Optional workflow tracking headers (injected automatically by workflow-service):
- `x-campaign-id` — campaign ID
- `x-brand-id` — comma-separated brand IDs (e.g. `uuid1,uuid2,uuid3`). Single UUID for single-brand campaigns.
- `x-workflow-slug` — workflow slug
- `x-feature-slug` — feature slug for tracking which feature triggered the request
- `x-audience-id` — audience attribution ID (the priority audience chosen by campaign-service for the run). Read into the request identity, forwarded on every internal call (client-service, email-gateway, runs-service), stored on the `email_events` row, and carried on the runs-service run so cost is attributed per audience. Absent outside campaign flows — omitted, never required.

When present, these are stored in the `email_events` table and forwarded to all downstream services. Brand IDs are parsed from CSV and stored as a `text[]` array in `brand_ids`.

### `POST /send`

**Request body:**

```json
{
  "eventType": "welcome",
  "brandIds": ["brand_xxx"],
  "campaignId": "campaign_xxx",
  "productId": "webinar-2026-03-01",
  "bccEmails": ["ops@example.com"],
  "metadata": { "name": "Alice" }
}
```

| Field            | Required | Description                              |
| ---------------- | -------- | ---------------------------------------- |
| `eventType`      | Yes      | Event type (see below)                   |
| `brandIds`       | No       | Array of brand IDs (UUIDs) for tracking; omitted if not provided |
| `campaignId`     | No       | Campaign ID for tracking; omitted if not provided |
| `productId`      | No       | Product/instance ID for product-scoped dedup (e.g. webinar ID) |
| `recipientEmail` | No       | Direct recipient email (overrides client-service resolution if provided) |
| `bccEmails`      | No       | Blind-copy recipient emails delivered as provider-level BCC; not rendered into templates or stored in metadata |
| `metadata`       | No       | Template-specific data                   |

**Error responses:**

| Status | Condition |
| ------ | --------- |
| 400    | Missing required headers (`x-org-id`, `x-user-id`, `x-run-id`) or missing `eventType` |
| 404    | No template found for the given `eventType` |

### `GET /stats`

Returns aggregated email stats scoped to the caller's org (from `x-org-id` header).

**Query parameters:**

| Parameter      | Required | Description                              |
| -------------- | -------- | ---------------------------------------- |
| `eventType`    | No       | Filter by event type                     |

**Example:** `GET /stats?eventType=welcome`

**Response:**

```json
{
  "stats": {
    "totalEmails": 42,
    "sent": 40,
    "failed": 2,
    "pending": 0
  }
}
```

Email status lifecycle: `pending` → `sent` (after gateway confirms delivery) or `failed` (if gateway errors).


### `PUT /templates`

Deploy (upsert) email templates. Idempotent: creates new templates or updates existing ones matched by `name`. Call this at app startup to register all your email templates. Templates support `{{variable}}` interpolation from metadata passed at send time.

**Request body:**

```json
{
  "templates": [
    {
      "name": "welcome",
      "subject": "Welcome to {{appName}}!",
      "htmlBody": "<h1>Welcome {{name}}!</h1>",
      "textBody": "Welcome {{name}}!",
      "from": "GrowthAgency <hello@growthagency.dev>"
    }
  ]
}
```

| Field      | Required | Description                              |
| ---------- | -------- | ---------------------------------------- |
| `templates`| Yes      | Array of templates (at least one)        |
| `templates[].name` | Yes | Template name (matches `eventType` in `/send`) |
| `templates[].subject` | Yes | Email subject (supports `{{var}}` interpolation) |
| `templates[].htmlBody` | Yes | HTML body (supports `{{var}}` interpolation) |
| `templates[].textBody` | No | Plain text body (supports `{{var}}` interpolation) |
| `templates[].from` | No | Sender address, e.g. `"Display Name <email@domain.com>"`. If omitted, the email gateway default is used. |

**Response:**

```json
{
  "templates": [
    { "name": "welcome", "action": "created" }
  ]
}
```

**Usage pattern (app startup):**

```typescript
// instrumentation.ts
export async function register() {
  await fetch(`${process.env.TRANSACTIONAL_EMAIL_SERVICE_URL}/templates`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY!,
    },
    body: JSON.stringify({
      templates: [
        {
          name: "welcome",
          subject: "Welcome!",
          htmlBody: "<h1>Welcome!</h1>",
          textBody: "Welcome!",
          from: "MyApp <hello@myapp.dev>",       // optional: custom sender address
        },
      ]
    }),
  });
}
```

### `POST /internal/transfer-brand`

**Internal endpoint** — requires `x-api-key` only, no identity headers.

Re-assigns `email_events` rows from one org to another for a given brand. Only updates solo-brand rows (where `brand_ids` contains exactly one element matching `sourceBrandId`). When `targetBrandId` is provided, also rewrites the brand reference. Co-branding rows are skipped. Idempotent.

**Request body:**

```json
{
  "sourceBrandId": "uuid",
  "sourceOrgId": "uuid",
  "targetOrgId": "uuid",
  "targetBrandId": "uuid (optional)"
}
```

**Response:**

```json
{
  "updatedTables": [
    { "tableName": "email_events", "count": 42 }
  ]
}
```

### `GET /health`

Returns `{ "status": "ok" }`. No authentication required.

### `GET /openapi.json`

Returns the OpenAPI spec for this service. No authentication required. Used by the [API Registry Service](https://github.com/shamanic-technologies/api-registry-service) to discover and index endpoints.

## Dedup Strategies

Templates are deployed by calling services at startup via `PUT /templates`. The dedup and recipient routing logic remains in this service:

| Strategy | Events | Key format |
| -------- | ------ | ---------- |
| Once per email | `waitlist` | `{orgId}:waitlist:{email}` |
| Once per user | `welcome`, `signup_notification` | `{orgId}:{eventType}:{userId}` |
| Daily per user | `user_active` | `{orgId}:{eventType}:{userId}:{date}` |
| Per email × product | `webinar_welcome`, `j_minus_3`, `j_minus_2`, `j_minus_1`, `j_day` | `{orgId}:{eventType}:{email}:{productId}` |
| None (repeatable) | Any event not listed above | — |

Admin notification events (`signup_notification`, `signin_notification`, `user_active`) are always routed to the admin emails (`kevin@distribute.you`, `adam@distribute.you`) regardless of the caller's identity.

## Tech Stack

- **Runtime:** Node 20, TypeScript (ESM)
- **Framework:** Express
- **Database:** PostgreSQL via Drizzle ORM
- **Email delivery:** Email Gateway (routes to Postmark/Instantly)
- **User resolution:** Client Service
- **Validation & OpenAPI:** Zod + @asteasolutions/zod-to-openapi
- **Deployment:** Railway (Docker)

## Setup

```bash
cp .env.example .env   # fill in values
npm install
npm run db:push         # push schema to database
npm run dev             # start dev server on PORT
```

## Environment Variables

| Variable | Description |
| -------- | ----------- |
| `TRANSACTIONAL_EMAIL_SERVICE_DATABASE_URL` | PostgreSQL connection string |
| `TRANSACTIONAL_EMAIL_SERVICE_API_KEY` | API key for authenticating requests |
| `EMAIL_GATEWAY_SERVICE_URL` | Email Gateway endpoint (default: https://email-gateway.distribute.you) |
| `EMAIL_GATEWAY_SERVICE_API_KEY` | Email Gateway API key |
| `TRANSACTIONAL_BCC_EMAILS` | Optional comma-separated static BCC list silently added to every email sent by `sendEmail()` (staff oversight). Merged + de-duplicated with any caller-supplied `bccEmails`. Unset = no static BCC. |
| `RUNS_SERVICE_URL` | Runs service endpoint (default: http://localhost:3006) |
| `RUNS_SERVICE_API_KEY` | Runs service API key |
| `CLIENT_SERVICE_URL` | Client service endpoint (default: http://localhost:3010) |
| `CLIENT_SERVICE_API_KEY` | Client service API key |
| `SERVICE_URL` | Public URL used in OpenAPI spec (default: http://localhost:3000) |
| `PORT` | Server port (default: 3008) |

## Scripts

| Script | Description |
| ------ | ----------- |
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` and generate OpenAPI spec |
| `npm run generate:openapi` | Generate `openapi.json` from Zod schemas |
| `npm start` | Run compiled server |
| `npm test` | Run unit tests (Vitest, excludes integration) |
| `npm run test:unit` | Same as `npm test` |
| `npm run test:integration` | Run integration tests (requires database) |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:migrate` | Run migrations |
| `npm run db:push` | Push schema directly |
| `npm run db:studio` | Open Drizzle Studio |

## Project Structure

```
src/
  index.ts              # Express app entry point
  schemas.ts            # Zod schemas + OpenAPI registry (single source of truth)
  db/
    index.ts            # Database connection
    schema.ts           # Drizzle schema (email_events + email_templates tables)
  lib/
    client-service.ts   # Client service user email resolution
    email-gateway.ts    # Email Gateway client
    runs-client.ts      # Runs service client (create/update runs)
    trace-event.ts      # Fire-and-forget event tracing to runs-service
  middleware/
    auth.ts             # API key + identity header authentication
  routes/
    health.ts           # Health check endpoint
    openapi.ts          # GET /openapi.json endpoint
    send.ts             # POST /send endpoint with dedup logic
    stats.ts            # GET /stats + POST /stats (deprecated) for aggregated email stats
    templates.ts        # PUT /templates endpoint for template registration
    transfer-brand.ts   # POST /internal/transfer-brand for brand ownership transfer
  templates/
    index.ts            # Template registry (DB lookup, {{var}} interpolation)
tests/
  migrations.test.ts    # Validates migration files use idempotent patterns
  ...
scripts/
  generate-openapi.ts   # OpenAPI spec generation via zod-to-openapi
```
