# Transactional Email Service

Transactional email service that sends event-triggered emails. Resolves recipients via client-service, deduplicates sends, renders HTML/text templates, and delivers via the Email Gateway.

## API

### `POST /send`

Requires `x-api-key` header.

**Request body:**

```json
{
  "appId": "mcpfactory",
  "eventType": "welcome",
  "brandId": "brand_xxx",
  "campaignId": "campaign_xxx",
  "productId": "webinar-2026-03-01",
  "userId": "uuid-xxx",
  "metadata": { "name": "Alice" }
}
```

| Field            | Required | Description                              |
| ---------------- | -------- | ---------------------------------------- |
| `appId`          | Yes      | App identifier (e.g. `mcpfactory`)       |
| `eventType`      | Yes      | Event type (see below)                   |
| `brandId`        | No       | Brand ID (UUID) for tracking; omitted if not provided |
| `campaignId`     | No       | Campaign ID for tracking; omitted if not provided |
| `productId`      | No       | Product/instance ID for product-scoped dedup (e.g. webinar ID) |
| `userId`         | No       | Internal user ID to resolve email via client-service |
| `orgId`          | No       | Internal org ID (client-service UUID). Required for run/cost tracking — if omitted, no run is created in runs-service |
| `recipientEmail` | No       | Direct email (fallback if no userId)     |
| `metadata`       | No       | Template-specific data                   |

One of `userId` or `recipientEmail` is required.

**Error responses:**

| Status | Condition |
| ------ | --------- |
| 400    | Missing required fields (`appId`, `eventType`, or recipient) |
| 404    | No templates registered for the given `appId` or `eventType` |

### `POST /stats`

Requires `x-api-key` header.

**Request body:**

```json
{
  "appId": "mcpfactory",
  "orgId": "uuid-xxx",
  "userId": "uuid-xxx",
  "eventType": "welcome"
}
```

| Field          | Required | Description                              |
| -------------- | -------- | ---------------------------------------- |
| `appId`        | No       | Filter by app ID                         |
| `orgId`        | No       | Filter by org ID                         |
| `userId`       | No       | Filter by user ID                        |
| `eventType`    | No       | Filter by event type                     |

At least one filter is required.

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

Deploy (upsert) email templates. Idempotent: creates new templates or updates existing ones matched by `(appId + name)`. Call this at app startup to register all your email templates. Templates support `{{variable}}` interpolation from metadata passed at send time.

Requires `x-api-key` header.

**Request body:**

```json
{
  "appId": "growthagency",
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
| `appId`    | Yes      | App identifier                           |
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
    headers: { "Content-Type": "application/json", "x-api-key": process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY! },
    body: JSON.stringify({
      appId: "my-app",
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

### `GET /health`

Returns `{ "status": "ok" }`.

### `GET /openapi.json`

Returns the OpenAPI spec for this service. Used by the [API Registry Service](https://github.com/shamanic-technologies/api-registry-service) to discover and index endpoints.

## Event Types (mcpfactory)

| Event               | Dedup Strategy | Recipient |
| ------------------- | -------------- | --------- |
| `waitlist`          | Once per email | User      |
| `welcome`           | Once per user/email | User  |
| `signup_notification` | Once per user | Admin     |
| `signin_notification` | None (repeatable) | Admin |
| `campaign_created`  | None (repeatable) | User   |
| `campaign_stopped`  | None (repeatable) | User   |
| `user_active`       | Daily per user | Admin     |

## Event Types (generic)

Product-scoped events for webinar/event transactional emails. Require `productId` and `recipientEmail`.

| Event               | Dedup Strategy              | Recipient |
| ------------------- | --------------------------- | --------- |
| `webinar_welcome`   | Once per email × product    | User      |
| `j_minus_3`         | Once per email × product    | User      |
| `j_minus_2`         | Once per email × product    | User      |
| `j_minus_1`         | Once per email × product    | User      |
| `j_day`             | Once per email × product    | User      |

Dedup key format: `{appId}:{eventType}:{recipientEmail}:{productId}`

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
| `EMAIL_GATEWAY_SERVICE_URL` | Email Gateway endpoint (default: https://email-gateway.mcpfactory.org) |
| `EMAIL_GATEWAY_SERVICE_API_KEY` | Email Gateway API key |
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
| `npm test` | Run tests (Vitest) |
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
    schema.ts           # Drizzle schema (email_events + email_templates tables, incl. sender config)
  lib/
    client-service.ts   # Client service user email resolution
    email-gateway.ts    # Email Gateway client
    runs-client.ts      # Runs service client (create/update runs, skipped when no orgId)
  middleware/
    auth.ts             # API key authentication
  routes/
    health.ts           # Health check endpoint
    openapi.ts          # GET /openapi.json endpoint
    send.ts             # POST /send endpoint with dedup logic
    stats.ts            # POST /stats endpoint for aggregated email stats
    templates.ts        # PUT /templates endpoint for template registration
  templates/
    index.ts            # Template registry (DB-first lookup with hardcoded fallback)
    mcpfactory/         # MCP Factory app templates (hardcoded)
      layout.ts         # Shared HTML layout
      waitlist.ts
      welcome.ts
      signup-notification.ts
      signin-notification.ts
      campaign-created.ts
      campaign-stopped.ts
      user-active.ts
    generic/            # Generic webinar/event templates (hardcoded)
      layout.ts         # Minimal unbranded layout
      webinar-welcome.ts
      j-minus-3.ts
      j-minus-2.ts
      j-minus-1.ts
      j-day.ts
scripts/
  generate-openapi.ts   # OpenAPI spec generation via zod-to-openapi
```
