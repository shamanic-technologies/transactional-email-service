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
| `bccEmails`      | No       | Blind-copy recipient emails delivered as provider-level BCC; not rendered into templates or stored in metadata. On a customer-facing event `kevin@distribute.you` is added to whatever is supplied here (see Blind copy and replies); on a staff-routed event nothing is added |
| `metadata`       | No       | Template-specific data                   |

**Error responses:**

| Status | Condition |
| ------ | --------- |
| 400    | Missing required headers (`x-org-id`, `x-user-id`, `x-run-id`) or missing `eventType` |
| 404    | No template found for the given `eventType` |

### `POST /platform-send`

Same body, dedup, template resolution, run tracking and response shape as `POST /send`, for callers that hold an organisation and an API key but no end-user identity — e.g. stripe-service reacting to a Stripe webhook, where the customer acted inside Stripe's billing portal and no user of ours took any action.

Only staff-bound event types are accepted (`signup_notification`, `signin_notification`, `user_active`, `brand_daily_budget_changed`, `payment_method_removed`, `staff_daily_digest`, `provider_credits_exhausted`, `unpaid_debt_uncollectable`), so no request on this path can reach a customer. `recipientEmail` and `bccEmails` are rejected for the same reason.

With no acting user, the `email_events` row stores `user_id = NULL`, the runs-service run is created org-only, no `x-user-id` is forwarded downstream, and no actor email is added to metadata.

```bash
curl -X POST "$TRANSACTIONAL_EMAIL_SERVICE_URL/platform-send" \
  -H "x-api-key: $TRANSACTIONAL_EMAIL_SERVICE_API_KEY" \
  -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"eventType":"payment_method_removed","metadata":{"cardLast4":"4242","remainingChargeableCards":"0"}}'
```

#### Reporting that a paid provider has run out of credits

`provider_credits_exhausted` is the event type a backend service raises when it detects that a paid third-party provider is out of credits, so work depending on that provider now produces nothing. It needs an org and an API key, nothing else.

```bash
curl -X POST "$TRANSACTIONAL_EMAIL_SERVICE_URL/platform-send" \
  -H "x-api-key: $TRANSACTIONAL_EMAIL_SERVICE_API_KEY" \
  -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "provider_credits_exhausted",
    "metadata": {
      "provider": "Apollo.io",
      "reason": "people/search returned 402 with credits_remaining: 0 on 3 consecutive calls",
      "detail": "HTTP 402 {\"error\":\"insufficient_credits\",\"credits_remaining\":0}"
    }
  }'
```

| Metadata field | Required | Description |
| -------------- | -------- | ----------- |
| `provider`     | Yes      | Which provider is dry, as staff would name it |
| `reason`       | Yes      | Why the caller concluded it is out of credits |
| `detail`       | No       | Any raw upstream status or response body, free-form |
| `orgId`        | —        | Filled in from `x-org-id`; a supplied value is overwritten |

A missing or blank `provider` or `reason` is a 400: a staff alert with blanks where the facts belong is not actionable. The alert is deduped once per org per calendar day, so a service that hits the credit wall on thousands of consecutive operations mails staff once and the repeats come back `{ sent: false, reason: "duplicate" }`. The next calendar day it can raise again. Its template is registered by this service on boot, not by the caller.

**Error responses:**

| Status | Condition |
| ------ | --------- |
| 400    | Missing `x-org-id`, missing `eventType`, a non-staff-bound `eventType`, `recipientEmail`/`bccEmails` supplied, or a `provider_credits_exhausted` with no `provider` or no `reason` |
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

A mailing list is a platform-level list of bare email addresses — `investors` is the first one, a changelog or customer newsletter list is the obvious next. Lists belong to the platform, not to a customer organisation, and nothing here is filtered by org. Every route requires `x-api-key` and `x-org-id`, and every route but the preview requires `x-user-id`; `x-org-id` and `x-user-id` are the **sending identity** only (key-service resolves the Postmark token and stream against them, and a send is billed to that organisation).

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
  "body": "## Q3 update\n\nRevenue **doubled**.\n\n![chart](https://cdn.example.com/q3.png)",
  "from": "news@news.distribute.you"
}
```

An update carries exactly one body: `body` as markdown, which this service renders, or `htmlBody` as a finished document the author wrote. Stating both, or neither, is a **400** — there is no rule for which would win, and the one picked silently would be discovered by everyone who reads the email.

`body` is markdown — headings, bold, links, tables, and `![alt](url)` inline images. It is rendered to HTML for delivery, and the markdown itself is sent as the plain-text part. Do not add an unsubscribe link: email-gateway appends a discreet one to every transactional HTML body, and Postmark resolves it against the broadcast stream.

`htmlBody` is a complete HTML document staff authored, sent to every recipient **byte-for-byte as supplied**: nothing is re-rendered, no styles are inlined for you, and it is not wrapped in the markdown template's shell. It exists for a designed newsletter — table layout, inline styles on every element, hosted PNG or JPEG images, a 600px measure — which markdown cannot express. The same rules for authored markup apply as for the rendered kind (inline styles only, table geometry, no `<style>` block worth relying on), because the client does not care who wrote the markup.

Everything else is identical for both kinds: email-gateway appends the unsubscribe footer, suppressed members are skipped against Postmark at send time, one message goes per recipient, `from` selects the sender, and the update is recorded.

A message always carries a text part. For markdown it is the markdown. For `htmlBody` it is the optional `textBody` when the author writes one, and otherwise one derived from the HTML — tags dropped, links kept as `label (url)`, entities unescaped. A document that yields no text at all (an all-image layout) is refused with a **400** asking for `textBody`, because clients that prefer text would show an empty message. `textBody` beside `body` is also a **400**: a markdown update's text part is its markdown, so a `textBody` there would be dropped without a word.

The HTML carries every style inline on the element. Gmail discards `<style>` and `<head>` and Outlook's Word engine ignores most of what is left, so a stylesheet renders in a browser preview and arrives unstyled in the inbox. Layout is a centred table capped at 600px with `width:100%`, which gives a readable measure on a desktop and no horizontal scroll on a phone; images are capped at `max-width:100%`, and tables use `table-layout:fixed` with percentage columns (the label column wider than the figures) so a row wraps instead of pushing the message sideways. Nothing depends on flexbox, grid, custom properties or class attributes.

An update carrying an **SVG image is rejected with a 400** naming the URL, whichever kind of body it came in. Gmail, Outlook and Yahoo all refuse `image/svg+xml` and render the alt text in a broken-image placeholder instead, and the sender knows the body before it goes out. Use PNG or JPEG. Both `![alt](…​.svg)` and a raw `<img src="….svg">` are caught, including `.svgz`, a query string or fragment after the extension, and `data:image/svg+xml` URIs.

One message is sent per recipient, in waves of 8, so no recipient ever appears in another recipient's headers.

`from` is optional and applies to that send only. Omit it and the update leaves `kevin@distribute.you`, which is where every update went before the field existed, so a caller that never states one keeps sending exactly what it sent before. State one to send from another verified identity — a newsletter leaving a dedicated subdomain rather than the address investors hear from.

The address must be a sender Postmark has verified. An unverified one is refused for every recipient identically, so the send stops after the first wave and answers **502** with the provider's own reason; it is never retried onto the default, because a newsletter arriving from the investor address is worse than a newsletter that did not go out. The update is still recorded, as `failed`.

**Response:**

```json
{
  "updateId": "31382def-19eb-4810-b399-a198f3b8940a",
  "slug": "investors",
  "subject": "Q3 update",
  "status": "sent",
  "from": "kevin@distribute.you",
  "recipientCount": 12,
  "skippedOptedOut": ["b@fund.com"],
  "failures": []
}
```

`status` is `partial` when at least one recipient failed, and `failures` names each one with the provider's reason. A partial send is never recorded as a clean success. `failed` means nobody was reached at all; that answer is a 502 carrying an `error` field with the provider's reason beside the same body.

#### `POST /mailing-lists/updates/preview`

Renders a draft the way a recipient will receive it and does nothing else: no message goes out, no update is recorded, no suppression state is read. It takes no list slug and no `x-user-id` — the body renders the same whoever receives it, and nothing here resolves a provider key or spends.

**Request body:** the same body fields as a send — `body`, or `htmlBody` with an optional `textBody`.

**Response:** `{ "htmlBody": …, "textBody": …, "bodyKind": "markdown" | "html", "unrenderableImages": [] }`

The rendering is the same code path a send takes, so approving a preview is approving what lands in the inbox. An authored `htmlBody` comes back unchanged, which is also what a send does with it. Unrenderable images are **reported** here rather than refused: a browser renders SVG happily, which is exactly the trap, so the body still renders and the offending URLs come back beside it.

#### `GET /mailing-lists/{slug}/updates`

Every update sent to the list, newest first, with the subject, the sender it went out from (`from`), `bodyKind` (`"markdown"` or `"html"`), the markdown as authored in `body` (`null` for an update authored as HTML — there was none), the HTML as sent, the timestamp and the recipient count. Updates sent before the sender could be stated read as `kevin@distribute.you`, which is what they were sent from.

#### Releases: sending one update over several days

`POST /mailing-lists/{slug}/updates` puts the whole list out **inside the request that asked for it**. That is right for `investors` (one address) and impossible for a list of thirty thousand: the send takes 15-25 minutes of wall clock, an HTTP client abandons a response after 300 seconds while the service keeps sending, nothing records which addresses were reached, and there is no way to slow it down or stop it. So that route now refuses any list over **100 subscribers** with a 400 naming the release route, rather than timing out in silence.

A **release** is the same update plus a daily pace. Creating one writes a ledger row per address and answers in about a second, sending nothing. An interval inside the service then releases it over the following days.

Three properties, and each is a consequence of the ledger rather than of care taken at the right moment:

- **Nobody is mailed twice.** A recipient row is claimed by an `UPDATE` that only moves rows out of `pending`, under `FOR UPDATE SKIP LOCKED`, and the unique index on (release, email) means a second row for somebody cannot exist. Issuing the same release twice returns the first one rather than starting a second.
- **Nobody is lost.** Every address is a row from the moment the release is created and ends in a terminal status with a reason. A claim a killed process left behind is settled as failed, naming what happened, rather than returned to the queue — this service cannot ask the provider whether that one message left, and a newsletter delivered twice is worse than one address reported honestly. A redeploy sends `SIGTERM`, which lets the slice in flight settle first, so a planned restart loses nobody at all.
- **Suppression is reconciled per slice**, with no cache at all, at the moment that slice is sent. Somebody who unsubscribes on day one is skipped on day five.

The pace is an in-process interval armed after the port is bound, not a cron. A GitHub Actions cron declares a cadence it does not deliver (measured elsewhere in this fleet at 6.2 runs a day against 24 declared, with gaps of 2.5 to 5.7 hours), and a release's pace is the product. `POST /internal/mailing-lists/releases/tick` exists so a cron can be a **backstop** for a process that died, never as the mechanism.

The day's allowance is spread across the ticks left in the day rather than spent at midnight, and a day whose allowance is reached simply rests until the next one. One tick takes at most 20 addresses, which is also the point past which the provider's suppression read stops being per-address and becomes a dump of the whole broadcast stream. That ceiling every minute is **28,800 a day**, and a `dailyLimit` above it is refused rather than silently under-delivered.

A release reads its own delivery outcomes back from email-gateway (`GET /public/stats/by-operation?operationId=mailing-list-release-<releaseId>`). Past 500 sends, a bounce rate above 5% or an unsubscribe rate above 3% stops the release and raises the `mailing_list_release_halted` staff alert. The stake is not this send: the provider's complaint threshold applies to the whole account, so a spike here suspends onboarding and dunning mail too. A probe that cannot be answered decides nothing — it is logged and asked again next tick, never read as healthy.

> **Why the read is keyed on the release's tag and not on its run.** Every message carries the release's run id, but email-gateway mints a **child** run per send and records *that* against the message, so a query keyed on the release's own run matches nothing — measured in production on v0.22.0: the release run returned `sent: 0` while its child returned `sent: 1`. The self-halt was inert for the whole of v0.22.x because of it: an empty match and a real zero came back identically, so the probe saw zero every tick and never had grounds to stop anything.
>
> The handle is instead the tag every one of a release's messages already carries, `mailing-list-release-<releaseId>` — per release, never per list — written by `releaseOperationId` in `src/lib/release-operation.ts` and read back through the same helper. One indexed lookup on the provider whatever the release's size.
>
> **An operation that matches no message is now reported as matching none**, not as zero outcomes: email-gateway answers `matched: false` with no stats at all, and `fetchDeliveryOutcomes` throws on it. The worker treats that exactly like an unreachable gateway — it logs and asks again next tick, and decides nothing. A release created before the per-release tag shipped therefore never self-halts and says so every tick, rather than reading as clean.

#### `POST /mailing-lists/{slug}/releases`

**Request body:** the same body `POST /mailing-lists/{slug}/updates` takes (`subject`, one of `body` or `htmlBody`, optional `textBody`, optional `from`), plus:

```json
{
  "subject": "September update",
  "htmlBody": "<html>…</html>",
  "from": "news@news.distribute.you",
  "dailyLimit": 3000
}
```

`dailyLimit` is required and has no default: the pace is the reason a release exists, and this service will not pick one on staff's behalf. Pick it for the sending reputation you have, not the list you hold — a sending subdomain two weeks old with a few hundred messages of lifetime volume is throttled or foldered by Gmail and Outlook if it jumps to tens of thousands.

**201** with `created: true` for a new release. **200** with `created: false` when this exact update is already being released to this list, carrying that release untouched. The response is the release's progress plus `estimatedDays`.

#### `GET /mailing-lists/releases/{releaseId}`

```json
{
  "releaseId": "…",
  "slug": "newsletter",
  "subject": "September update",
  "status": "running",
  "haltedReason": null,
  "dailyLimit": 3000,
  "recipientCount": 30013,
  "reached": 4820,
  "remaining": 25100,
  "failed": 3,
  "skippedOptedOut": 90,
  "inFlight": 0,
  "todayAllowance": 3000,
  "todayUsed": 1820,
  "nextSliceSize": 20,
  "estimatedDaysRemaining": 9
}
```

Counted from the ledger, so a redeploy does not change the answer. `estimatedDaysRemaining` is arithmetic over the pace and what is still waiting, today included when today can still carry somebody: it is 0 when nobody is waiting, and 0 for a release that is not going to run again.

#### `GET /mailing-lists/{slug}/releases`

Every release created for this list, newest first, each with the progress above.

#### `POST /mailing-lists/releases/{releaseId}/pause`, `/resume`, `/cancel`

Pause stops it within one tick. Resume continues where it stopped, and repeats nobody across the gap. Cancel ends it, settles every waiting address as cancelled so the ledger says what happened to all of them, and it never resumes. A release that stopped itself on the provider's outcomes is not resumed either — sending the same update again is a new release, so the decision is made rather than undone. A move that is not a move answers **409**.

#### `PATCH /mailing-lists/releases/{releaseId}/pace`

```json
{ "dailyLimit": 500 }
```

Changes how fast a release goes out **while it is going out**. The pace a release was created with is a guess made before the first message left, and the reason a release is paced at all (sending reputation) is the one thing that guess could not be informed by. This takes the decision again on the evidence the release has since produced, which the service already reads back for itself.

It governs from the moment it is accepted. Raising it makes more of today's allowance available at once, without waiting for tomorrow. Lowering it below what the day has already sent claws nothing back and fails nothing: the day rests and the new pace governs from the next one. Only one column moves and the ledger is untouched, which is why nobody already reached is reached again and nobody waiting is dropped, across any number of changes.

The ceiling is the same **28,800 a day** the create route applies, for the same reason, and a pace above it is **400**. Only a running or paused release takes a new pace: one that has completed, was cancelled, or stopped itself on the provider's delivery outcomes answers **409** naming which it is. The response is the release's progress at the new pace, with a revised `estimatedDaysRemaining`.

#### `POST /internal/mailing-lists/releases/tick`

Runs one pass over every running release and reports what it did (`x-api-key` only). The backstop described above. Safe to call at any time: two ticks never overlap, and a call arriving while one runs answers `skippedBusy: true`.

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
| Daily per org | `provider_credits_exhausted` | `{orgId}:{eventType}:{YYYY-MM-DD}` |
| None (repeatable) | `brand_daily_budget_changed`, `payment_method_removed`, `staff_daily_digest`, `unpaid_debt_uncollectable`, and any event not listed above | — |

Monthly per-brand dedup caps a send to at most once per org per brand per calendar month. Brand and month derive entirely from the existing request (`x-brand-id` header, or `brandIds` body field). A send in a new calendar month, or for a different brand, goes through; a repeat within the same brand and month returns `{ sent: false, reason: "duplicate" }`. If no brand identity is present the event falls through to no-dedup (repeatable).

Admin notification events (`signup_notification`, `signin_notification`, `user_active`, `brand_daily_budget_changed`, `payment_method_removed`, `staff_daily_digest`, `provider_credits_exhausted`, `unpaid_debt_uncollectable`) are always routed to the staff recipient list (`kevin.lourd@gmail.com`) regardless of the caller's identity. That list is hardcoded in `send.ts`, never read from the environment, so it cannot drift or be disabled by a missing variable. Their metadata is enriched with the acting user's email under `email` when the caller did not supply one and there is an acting user; a machine caller with no acting user sends no actor metadata at all.

`brand_daily_budget_changed` is emitted by billing-service on every real change to a brand's daily budget. It carries no dedup, so two changes on the same day produce two notifications.

`payment_method_removed` is emitted by stripe-service when a customer detaches a card in Stripe's billing portal. There is no acting user of ours, so it arrives on `POST /platform-send`. It carries no dedup: losing one of two cards and going to zero chargeable cards are different situations and staff needs both.

`provider_credits_exhausted` is raised by any backend service that detects a paid third-party provider has run out of credits — apollo-service on Apollo.io credit exhaustion is the first. There is no acting user, so it arrives on `POST /platform-send`. Its dedup key holds neither a recipient nor a user, so a machine caller deduplicates exactly like one with an acting user: one alert per org per calendar day, however many operations hit the wall. It accepts no `recipientEmail` and no `bccEmails` on any route, so it cannot reach a customer address, and unlike the product templates its own template ships in this repo (`src/templates/staff-alerts.ts`) and is registered on boot — no consuming app owns a staff alert, and leaving it to callers would mean every future caller shipping its own copy of the same email.

`unpaid_debt_uncollectable` is emitted by billing-service when an org's balance has gone negative and no card is on file to collect it on. It carries no dedup: billing-service decides when a debt is worth reporting.

`staff_daily_digest` is emitted once a day by the customer dashboard, which owns and registers the template under that exact name. It has no acting user, so it arrives on `POST /platform-send`, and it carries no dedup — the dashboard decides when a digest goes out.

### Blind copy and replies

A **customer-facing** send is blind-copied to `kevin@distribute.you`, so the company sees what it tells a customer as it tells them rather than going looking for the message in a provider archive afterwards. A caller's own `bccEmails` are kept and that one address is added to them, never in place of them, and an address the caller already named is not doubled.

Two sends do **not** carry it. A **staff-routed** event (the list under Staff routing above) already reaches the same person as a primary recipient, so a blind copy would deliver the message twice. A **mailing-list update** is a fan-out to many people rather than an email to a customer: one blind copy per recipient would flood an inbox and multiply the provider bill by the size of the list.

The blind copy is exactly ONE address, hardcoded in `src/lib/founder.ts`. A multi-address staff BCC existed and was removed in PR #126 because Postmark bills per recipient and counts blind copies, so every send was multiplied by the size of the staff list. One address at this service's volume (52 sends across every event type over the 14 days measured 2026-09-17) is a rounding error against that price. Do not grow it back into a list.

**Every** send from this service, staff-routed and customer-facing alike, sets `replyTo: kevin@distribute.you`, so a customer who hits reply reaches a human instead of wherever the sending address happens to route. A caller that names its own reply address keeps it.

Internal visibility does not rest on the blind copy alone: Postmark keeps the full message in its Activity archive for 45 days, and postmark-service writes a permanent metadata row per send.

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

### Tests

`npm test` runs the unit suite and needs no database. `npm run test:integration` does:
point `TRANSACTIONAL_EMAIL_SERVICE_DATABASE_URL` at an empty database and the suite
builds the schema from `drizzle/` itself, the same way the service does on boot.

CI starts a `postgres:16` service container per run and points the suite at it. The
database is created with the job and destroyed with it, so a run never shares a
database with another run or with a deployed environment.

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
| `npm run test:integration` | Run integration tests (requires an empty database; migrates it itself) |
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
    schema.ts           # Drizzle schema (email_events, email_templates, mailing_lists, mailing_list_subscribers, mailing_list_updates, mailing_list_releases, mailing_list_release_recipients)
  lib/
    address-blob.ts     # Lenient parser for a pasted blob of email addresses
    client-service.ts   # Client service user email resolution
    email-gateway.ts    # Email Gateway client; sets the default reply address, adds no blind copy of its own
    founder.ts          # The founder's address: reply-to on every send, blind copy on customer-facing ones
    mailing-list-body.ts # Markdown -> inline-styled HTML for updates; SVG-image guard; plain-text derivation for authored HTML
    mailing-list-sender.ts # The address an update leaves from when the caller states none
    update-body.ts      # Turns a stated body into the two parts a message carries; shared by preview, send and release
    release-pacing.ts   # Pure: how much one tick may send, and when outcomes are bad enough to stop
    release-operation.ts # The handle every message of one release carries; written at send, read back by the probe
    release-health.ts   # Reads a release's own delivery outcomes back from email-gateway, keyed on that handle
    release-worker.ts   # The interval that releases an update over days: claim, reconcile suppression, send, settle
    staff-recipients.ts # Where a staff-bound message goes; shared by /send and the release worker
    suppression.ts      # Postmark broadcast-stream suppression, per address, via key-service; short-lived cache, bypassed on send
    runs-client.ts      # Runs service client (create/update runs)
    trace-event.ts      # Fire-and-forget event tracing to runs-service
  middleware/
    auth.ts             # API key + identity header authentication (full identity, or org-only for machine callers)
  routes/
    health.ts           # Health check endpoint
    openapi.ts          # GET /openapi.json endpoint
    mailing-lists.ts    # Staff mailing lists: subscribers CRUD, send an update, read the history
    mailing-list-releases.ts # Create / read / re-pace / pause / resume / cancel a paced release, and the backstop tick
    send.ts             # POST /send + POST /platform-send endpoints with dedup logic
    stats.ts            # GET /stats + POST /stats (deprecated) for aggregated email stats
    templates.ts        # PUT /templates endpoint for template registration
    transfer-brand.ts   # POST /internal/transfer-brand for brand ownership transfer
  templates/
    index.ts            # Template registry (DB lookup, {{var}} interpolation)
    staff-alerts.ts     # Staff-alert templates this service owns, upserted on boot (provider_credits_exhausted, mailing_list_release_halted)
tests/
  migrations.test.ts    # Validates migration files use idempotent patterns
  ...
scripts/
  generate-openapi.ts   # OpenAPI spec generation via zod-to-openapi
  bench-suppression.mts # Times the subscribers read against a stand-in for key-service and Postmark
```
