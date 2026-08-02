# Transactional Email Service

Transactional email service that sends event-triggered emails. Resolves recipients via client-service, deduplicates sends, renders HTML/text templates, and delivers via the Email Gateway. Also hosts staff-owned mailing lists and the written updates broadcast to them.

## API

All protected endpoints require these headers:
- `x-api-key` — service API key
- `x-org-id` — internal org UUID from client-service
- `x-user-id` — internal user UUID from client-service
- `x-run-id` — caller's run ID

**Platform endpoints** (`/platform-*`) are for machine callers with no end-user session. `PUT /platform-templates` requires `x-api-key` only. `POST /platform-send` requires `x-api-key` and `x-org-id`; `x-user-id` and `x-run-id` are honoured when present but never required, and are never substituted with a placeholder when absent.

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
| `bccEmails`      | No       | Blind-copy recipient emails delivered as provider-level BCC; not rendered into templates or stored in metadata. A fixed staff BCC (`kevin@distribute.you`) is always appended automatically for internal archival, deduplicated with these |
| `metadata`       | No       | Template-specific data                   |

**Error responses:**

| Status | Condition |
| ------ | --------- |
| 400    | Missing required headers (`x-org-id`, `x-user-id`, `x-run-id`) or missing `eventType` |
| 404    | No template found for the given `eventType` |

### `POST /platform-send`

Same body, dedup, template resolution, run tracking and response shape as `POST /send`, for callers that hold an organisation and an API key but no end-user identity — e.g. stripe-service reacting to a Stripe webhook, where the customer acted inside Stripe's billing portal and no user of ours took any action.

Only staff-bound event types are accepted (`signup_notification`, `signin_notification`, `user_active`, `brand_daily_budget_changed`, `payment_method_removed`), so no request on this path can reach a customer. `recipientEmail` and `bccEmails` are rejected for the same reason.

With no acting user, the `email_events` row stores `user_id = NULL`, the runs-service run is created org-only, no `x-user-id` is forwarded downstream, and no actor email is added to metadata.

```bash
curl -X POST "$TRANSACTIONAL_EMAIL_SERVICE_URL/platform-send" \
  -H "x-api-key: $TRANSACTIONAL_EMAIL_SERVICE_API_KEY" \
  -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"eventType":"payment_method_removed","metadata":{"cardLast4":"4242","remainingChargeableCards":"0"}}'
```

**Error responses:**

| Status | Condition |
| ------ | --------- |
| 400    | Missing `x-org-id`, missing `eventType`, a non-staff-bound `eventType`, or `recipientEmail`/`bccEmails` supplied |
| 401    | Missing or invalid `x-api-key` |
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

### Mailing lists (staff-only)

A mailing list is a platform-level list of bare email addresses — `investors` is the first one, a changelog or customer newsletter list is the obvious next. Lists belong to the platform, not to a customer organisation, and nothing here is filtered by org. All five routes require `x-api-key`, `x-org-id` and `x-user-id`; `x-org-id` and `x-user-id` are the **sending identity** only (key-service resolves the Postmark token and stream against them, and a send is billed to that organisation).

Opt-out state is never stored here. Postmark's broadcast stream owns the suppression list — the native one-click unsubscribe, a spam complaint and a hard bounce all write to it — and both the list read and the send read it back from Postmark, using the platform token resolved through key-service. postmark-service's own mirror is not usable for this: it is org-scoped and only covers addresses already messaged under that org, so it reports a suppressed address as subscribed.

Two things keep that read cheap. Postmark's suppression dump takes an `EmailAddress` filter, so only the addresses on the list are read — the broadcast stream is shared with all outreach, so an unfiltered dump grows with total send volume and has nothing to do with the size of the list being read. And the resolved credentials plus each address's answer are held in process, credentials for five minutes and answers for one minute, so refreshing the page costs no provider call at all.

A send never reuses a cached answer: it re-checks every recipient against Postmark at send time. Someone who opted out a second ago, after a page load had already cached them as subscribed, is still skipped by that send. A provider failure throws on both paths — an empty suppression set is never assumed.

#### `GET /mailing-lists/{slug}/subscribers`

```json
{
  "slug": "investors",
  "count": 2,
  "subscribers": [
    { "email": "a@fund.com", "optedOut": false, "optedOutReason": null, "addedAt": "2026-08-02T03:23:26.301Z" },
    { "email": "b@fund.com", "optedOut": true, "optedOutReason": "HardBounce", "addedAt": "2026-08-02T03:23:26.379Z" }
  ]
}
```

`optedOutReason` is Postmark's own wording: `ManualSuppression` (unsubscribed), `SpamComplaint` or `HardBounce`.

#### `POST /mailing-lists/{slug}/subscribers`

Adds every readable address from a pasted blob, and creates the list on first use.

**Request body:** `{ "raw": "Ada <ada@fund.com>; bob@fund.com,\nnot-an-email" }`

The blob may be comma-, semicolon-, tab- or newline-separated, and may mix bare addresses with `Name <email>` pairs. Addresses are lower-cased. Duplicates inside the blob and addresses already on the list are skipped, so re-pasting the same blob is a no-op.

**Response:**

```json
{
  "slug": "investors",
  "added": ["ada@fund.com", "bob@fund.com"],
  "skipped": [],
  "rejected": [{ "value": "not-an-email", "reason": "not a valid email address" }]
}
```

#### `DELETE /mailing-lists/{slug}/subscribers?email=ada@fund.com`

Returns `{ "slug": "investors", "email": "ada@fund.com", "removed": true }`, or 404 if the address is not on the list.

#### `POST /mailing-lists/{slug}/updates`

Sends a written update to every member Postmark is not suppressing.

**Request body:**

```json
{
  "subject": "Q3 update",
  "body": "## Q3 update\n\nRevenue **doubled**.\n\n![chart](https://cdn.example.com/q3.png)"
}
```

`body` is markdown — headings, bold, links, tables, and `![alt](url)` inline images. It is rendered to HTML for delivery, and the markdown itself is sent as the plain-text part. Do not add an unsubscribe link: email-gateway appends a discreet one to every transactional HTML body, and Postmark resolves it against the broadcast stream.

The HTML carries every style inline on the element. Gmail discards `<style>` and `<head>` and Outlook's Word engine ignores most of what is left, so a stylesheet renders in a browser preview and arrives unstyled in the inbox. Layout is a centred table capped at 600px with `width:100%`, which gives a readable measure on a desktop and no horizontal scroll on a phone; images are capped at `max-width:100%`, and tables use `table-layout:fixed` with percentage columns (the label column wider than the figures) so a row wraps instead of pushing the message sideways. Nothing depends on flexbox, grid, custom properties or class attributes.

An update carrying an **SVG image is rejected with a 400** naming the URL. Gmail, Outlook and Yahoo all refuse `image/svg+xml` and render the alt text in a broken-image placeholder instead, and the sender knows the body before it goes out. Use PNG or JPEG. Both `![alt](…​.svg)` and a raw `<img src="….svg">` are caught, including `.svgz`, a query string or fragment after the extension, and `data:image/svg+xml` URIs.

One message is sent per recipient, in waves of 8, so no recipient ever appears in another recipient's headers. Every update is sent from `kevin@distribute.you`.

**Response:**

```json
{
  "updateId": "31382def-19eb-4810-b399-a198f3b8940a",
  "slug": "investors",
  "subject": "Q3 update",
  "status": "sent",
  "recipientCount": 12,
  "skippedOptedOut": ["b@fund.com"],
  "failures": []
}
```

`status` is `partial` when at least one recipient failed, and `failures` names each one with the provider's reason. A partial send is never recorded as a clean success.

#### `GET /mailing-lists/{slug}/updates`

Every update sent to the list, newest first, with the subject, the markdown as authored, the HTML as sent, the timestamp and the recipient count.

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
| Monthly per brand | `audience_fully_contacted` | `{orgId}:{eventType}:{sortedBrandIds}:{YYYY-MM}` |
| None (repeatable) | `brand_daily_budget_changed`, `payment_method_removed`, and any event not listed above | — |

Monthly per-brand dedup caps a send to at most once per org per brand per calendar month. Brand and month derive entirely from the existing request (`x-brand-id` header, or `brandIds` body field). A send in a new calendar month, or for a different brand, goes through; a repeat within the same brand and month returns `{ sent: false, reason: "duplicate" }`. If no brand identity is present the event falls through to no-dedup (repeatable).

Admin notification events (`signup_notification`, `signin_notification`, `user_active`, `brand_daily_budget_changed`, `payment_method_removed`) are always routed to the admin emails (`kevin@distribute.you`) regardless of the caller's identity. Their metadata is enriched with the acting user's email under `email` when the caller did not supply one and there is an acting user; a machine caller with no acting user sends no actor metadata at all.

`brand_daily_budget_changed` is emitted by billing-service on every real change to a brand's daily budget. It carries no dedup, so two changes on the same day produce two notifications.

`payment_method_removed` is emitted by stripe-service when a customer detaches a card in Stripe's billing portal. There is no acting user of ours, so it arrives on `POST /platform-send`. It carries no dedup: losing one of two cards and going to zero chargeable cards are different situations and staff needs both.

## Tech Stack

- **Runtime:** Node 20, TypeScript (ESM)
- **Framework:** Express
- **Database:** PostgreSQL via Drizzle ORM
- **Email delivery:** Email Gateway (routes to Postmark/Instantly)
- **User resolution:** Client Service
- **Provider suppression:** Postmark broadcast-stream suppression list, read with the platform token from Key Service
- **Markdown rendering:** marked (mailing-list update bodies)
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
| `RUNS_SERVICE_URL` | Runs service endpoint (default: http://localhost:3006) |
| `RUNS_SERVICE_API_KEY` | Runs service API key |
| `CLIENT_SERVICE_URL` | Client service endpoint (default: http://localhost:3010) |
| `CLIENT_SERVICE_API_KEY` | Client service API key |
| `KEY_SERVICE_URL` | Key service endpoint (default: http://localhost:3001). Used to resolve the Postmark token and broadcast stream for mailing-list suppression reads |
| `KEY_SERVICE_API_KEY` | Key service API key |
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
    schema.ts           # Drizzle schema (email_events, email_templates, mailing_lists, mailing_list_subscribers, mailing_list_updates)
  lib/
    address-blob.ts     # Lenient parser for a pasted blob of email addresses
    client-service.ts   # Client service user email resolution
    email-gateway.ts    # Email Gateway client
    mailing-list-body.ts # Markdown -> inline-styled HTML for updates; SVG-image guard
    suppression.ts      # Postmark broadcast-stream suppression, per address, via key-service; short-lived cache, bypassed on send
    runs-client.ts      # Runs service client (create/update runs)
    trace-event.ts      # Fire-and-forget event tracing to runs-service
  middleware/
    auth.ts             # API key + identity header authentication (full identity, or org-only for machine callers)
  routes/
    health.ts           # Health check endpoint
    openapi.ts          # GET /openapi.json endpoint
    mailing-lists.ts    # Staff mailing lists: subscribers CRUD, send an update, read the history
    send.ts             # POST /send + POST /platform-send endpoints with dedup logic
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
