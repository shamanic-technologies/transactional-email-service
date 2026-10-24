# Project: Transactional Email Service

Transactional email service that sends event-triggered emails. Resolves recipients via client-service, deduplicates sends, renders HTML/text templates, and delivers via the Email Gateway.

## A release's outcomes are read by its own RUN — and an empty match is not a zero

The self-halt on a mailing-list release is the only thing standing between a
30,013-address newsletter and an account-wide complaint suspension that would
take onboarding and dunning mail with it. It reads the release's outcomes back
from email-gateway, and the handle it reads them by has been wrong twice, both
times quietly, both times in the direction that reads as healthy.

`GET /public/stats?runIds=<the release's run>` matched nothing, because on that
read `runIds` means the CHILD run the provider mints per send. The answer was a
well-formed zero, every tick, for the whole of v0.22.x.

Keying on the send TAG then matched too much. A tag is per-TEMPLATE in storage,
not per-operation, so one release's question returned every release that ever
used the same template — measured in production as 11 messages for an operation
of 1. postmark-service withdrew the tag-keyed read for exactly that reason and
email-gateway conformed: its parameter is `operationRunId`, and a caller still
sending `operationId` gets a deliberate **400**.

What holds is the release's own RUN. Every send of a release already carries it
as `x-run-id`, postmark-service persists it as each message's PARENT run, and
`GET /public/stats/by-operation?operationRunId=<the release's run>` aggregates
exactly that set — this release's mail, no more and no less, in one indexed
lookup whatever the release's size. Nothing extra is written at send time.

The per-release tag (`releaseOperationId` in `src/lib/release-operation.ts`) is
still written on every message, and is still how a human finds one release's
mail in the Postmark Activity archive. It is simply not what an aggregate is
keyed on. That helper lives in its own module for a reason that costs a prod
incident otherwise: the worker's integration tests `vi.mock` the whole of
`release-health.js`, so a helper exported from there comes back `undefined`
inside the send path and every message goes out UNTAGGED — silently, because
each send is caught per address. The suite caught it; the only tell was a send
count of zero in an unrelated test.

`fetchDeliveryOutcomes` THROWS when the gateway reports `matched: false`. An
operation nothing belongs to is a question that found nothing, not a release
with clean outcomes, and the worker treats it exactly like an unreachable
gateway: log, decide nothing, ask again next tick. Do not "simplify" that into
reading the absent stats as zeros — that is the original bug. There is no
fallback to the tag handle and no dual read; a second handle answering one
question with a different number is the contradiction that was just removed.

## A release send names its subscriber for the cost ledger; nothing else names anybody

COST-ACCOUNTING-1023: postmark-service declares `message_sent` on a send's run
for the ONE person the sender names. A release send names the subscriber as
`{subjectService: "transactional-email-service", subjectId: mailing_list_subscribers.id}`
(one row per list + address, so the same id on every release) and states
`consumedOutcomeKeys: ["email_checked"]`. The verification before it passes the
same subject to apollo-service (`subjects` on `POST /email-verifications`), which
declares the `email_checked` it produced on it; a reused verdict declares nothing
and runs-service resolves the consumption to that subscriber's earlier one.
An address removed from the list after the release froze it is still sent,
naming nobody (one warn line). Transactional sends (receipts, codes, staff
alerts, lifecycle mail) are support functions: never give them a subject.
Helpers live in `src/lib/outcome-subject.ts` (own module: tests mock the others).

## Past release sends are declared on the release's own run (COST-BACKFILL-1023)

`POST /internal/outcome-backfill {dryRun}` (`src/lib/outcome-backfill.ts`) declares one `message_sent`
per subscriber reached on each release's OWN run, for sends settled before `LIVE_SUBJECTS_SINCE`
(2026-10-23T14:33:24Z, v0.25.23 live), through runs-service's batch door with the send's instant as
`occurredAt`. Never on the child runs: runs-service refuses `not_run_owner`, and postmark-service /
apollo-service skip every run under ours by agreement, so their past sends and verifications roll into
the release run's occurrences. Nothing is declared consumed (no past `email_checked` exists to resolve
to; an unknown-provenance consumption would charge the check twice). Sends after the cutoff are
declared live by postmark-service: never move the cutoff later. Transactional `email-*` runs are
support functions and are never backfilled.

## A release sends ONLY verdict `valid` — and no verdict means no send

Every slice is verified by apollo-service `POST /email-verifications` after the
suppression check (`src/lib/email-verification.ts`, called from
`verifySlice` in the worker). Only `valid` is sent; anything else settles as
`skipped_undeliverable` with `verdict` + `verification_id` on the row. A
failure to get verdicts sends NOTHING and returns the slice to `pending` — the
one place a claim goes back to the queue, and it is safe only because none of
those rows reached the gateway. Do not add an "assume deliverable" branch, do
not filter on Apollo `email_status` (97% of the list is `verified`, and so were
132 of the first 138 bounces). Skips do not consume the daily allowance. The
integration suite mocks `fetchVerdicts` (valid by default) the same way it
mocks release-health — keep the helper in its own module.

## Finding a send you just made: the provider's SEARCH is lagging, our own row is not

Verifying a real send means reading the raw delivered message, and that needs a
message id. Postmark's `/messages/outbound?recipient=…&tag=…` search is the
obvious way to get one and it is not reliable seconds after a send: the same
query returned five messages one minute and an empty list the next, and a
`tag=` filter for a send made 90 seconds earlier returned nothing across ten
polls. An empty result there is not evidence the send did not happen.

postmark-service writes a permanent row per send, immediately. Take the id from
there instead — `docker exec distribute-postgres-1 psql -U postgres -d
postmark_service -c "SELECT message_id, to_email, subject, submitted_at FROM
postmark_messages WHERE submitted_at > now() - interval '30 minutes' ORDER BY
submitted_at DESC"` — then read the headers with
`/messages/outbound/{id}/dump`, which is the RFC 5322 source. Not `/details`:
it carries no `Cc` and no `ReplyTo` key at all, so a header that IS set reads
as absent.

## A template says exactly what the client reads: only `{{name}}` is syntax

The renderer replaces `{{name}}` and nothing else, so `src/templates/syntax.ts`
refuses every other `{{` at registration (422, whole batch, nothing written)
and again at send time (422, nothing delivered, a `failed` event row with no
dedup key). Cost 2026-10-20: a client read "Hi{{#firstName}} Liudvikas{{/firstName}},".
Do not add mustache sections to make such a template pass, and do not relax
the check to the RENDERED output: metadata may legitimately contain `{{`.

## Every sent client email is served for the Unibox (TX-EMAIL-IN-UNIBOX-1024)

Owner 2026-10-24: « ça n'annule pas le transactionnel. Mais le transactionnel envoyé doit aussi être ajouté à l'Unibox ».
The send is untouched; the write that marks a row `sent` also stores the message as it went on the wire
(`sentMessageColumns` in `src/lib/sent-emails.ts`: subject, html, text, from, `sent_at`), on every send path.
`GET /internal/sent-emails` serves those rows for crm-service to MIRROR (crm reads siblings, never pushed to).
One sent row = one Unibox message; a failed row is never served; staff-routed events (`isStaffRoutedEvent`) never.
No per-template rule: every template takes this path. Rows sent before 0023 are REPLAYED from the current template
(`messageSource: "replayed"`), never written back. `sent_at` is millisecond-precision on purpose: the cursor is ISO ms,
a microsecond value would re-serve the same row forever.

## Commands

- `npm test` — run tests (Vitest)
- `npm run test:unit` — run unit tests only
- `npm run test:integration` — run integration tests only
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server with hot reload
- `npm start` — run compiled server
- `npm run generate:openapi` — regenerate `openapi.json`
- `npm run db:generate` — generate Drizzle migrations
- `npm run db:migrate` — run Drizzle migrations
- `npm run db:push` — push schema directly to database
- `npm run db:studio` — open Drizzle Studio

## Architecture

- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/index.ts` — Express app entry point
- `src/routes/` — Route handlers (`send.ts`, `stats.ts`, `health.ts`, `openapi.ts`, `templates.ts`, `transfer-brand.ts`, `mailing-lists.ts`, `sent-emails.ts`)
- `src/middleware/auth.ts` — API key + identity-header authentication
- `src/lib/client-service.ts` — client-service user email resolution
- `src/lib/email-gateway.ts` — Email Gateway client. **Adds no blind copy of its own**: a caller's `bccEmails` is forwarded exactly as supplied, and the standing blind copy is decided one layer up in `src/routes/send.ts`, where a customer-facing send can be told apart from a staff-list one. It does set `replyTo` on **every** send, defaulting to `FOUNDER_EMAIL` (`src/lib/founder.ts`), so a customer who hits reply reaches a human rather than wherever the sending address routes; a caller that names its own `replyTo` keeps it. `POST /send` exposes this as `replyToEmail` (e.g. instantly-service forwarding a prospect's reply so the customer answers the prospect); absent = founder default, refused on `STAFF_ONLY_DELIVERY_EVENTS` and on `/platform-send` like `ccEmails`.

  A caller's `ccEmails` are forwarded the same way, and nothing stands behind them at any layer. A Cc is read by every recipient and a reply-all reaches it, so putting somebody there is a statement about who is PARTY to the conversation — only the caller knows that, which is why there is no default and no inferred address. A caller that names none sends a message with no Cc header at all. Do not grow a standing Cc the way the Bcc has one: the founder blind copy exists so the company can WATCH a customer conversation, and watching is exactly what Bcc is for.
- `src/lib/founder.ts` — `kevin@distribute.you`, hardcoded for the same reason `ADMIN_EMAILS` is. A **customer-facing** send is blind-copied here so the company sees what it tells a customer as it tells them. A **staff-routed** event is not (he is already a primary recipient on the staff list, and a second copy delivers the message twice), and a **mailing-list broadcast** is not (a fan-out to many people, where one blind copy per recipient multiplies the provider bill by the size of the list). A caller's own `bccEmails` are kept and this address is added to them, never in place of them.
  A multi-address staff BCC existed and was removed in PR #126, and #129 pinned that reasoning into the source; PR #145 reversed it deliberately, on the owner's call, and corrected both. The removal was right about the mechanism: Postmark bills per recipient and counts blind copies, so a staff LIST multiplied every send (July 2026: 628 API calls, 2,797 billed emails). What answers it is that this is **ONE** address against a measured 52 sends in 14 days across every event type. Keep it one address. The Postmark Activity archive (45 days) and postmark-service's permanent per-send metadata row still exist and are still the durable record.
- Staff-bound events route to `ADMIN_EMAILS` in `src/routes/send.ts`, hardcoded rather than env-configured so the routing cannot silently drift or be disabled by a missing variable. Currently one address, `kevin.lourd@gmail.com`.
- A staff-routed event is never delivered to the staff recipient who IS the acting person (`metadata.email`, supplied or enriched, trimmed + case-insensitive; matched against the recipient AND that person's other addresses in `STAFF_IDENTITIES`, `src/lib/staff-recipients.ts`, which never adds a recipient): result `{ sent: false, reason: 'self_action' }`, no row, no run, one log line (owner: "I am aware of what I am doing"). No actor (machine callers) always sends; never extend this to customer-facing events.
- **A message only staff read is platform-paid** (`payerFor` in `src/lib/staff-recipients.ts`, applied per send in `handleSend`): when EVERY address on it (to, cc, bcc) is a staff address (`ADMIN_EMAILS` + `STAFF_IDENTITIES`, so the agency inbox `kevin@distribute.you` counts), `POST /orgs/send` carries `payer: "platform"` and postmark-service skips the org's credit gate and charges the org nothing. A client out of money is when staff most need the alert (2026-10-13: three `unanswered-question-check-in` lost to a 402 at -$96). Keyed on the ADDRESSES, never the event type: one customer address anywhere and the org pays as before. Callers change nothing.
- `src/templates/staff-alerts.ts` — the staff-alert templates this service owns, upserted on boot. This is the one exception to "template content is not stored in this repo" below, and it is narrow: a staff alert has no consuming app to own it. Any backend service can raise `provider_credits_exhausted`, so leaving the template to the caller would mean every future caller shipping its own copy of the same staff email — the drift the hardcoded `ADMIN_EMAILS` list exists to prevent. Product templates stay with the app that sends them. An alert whose alerting service also owns the recipient list owns the template with it.
- A staff alert raised by a machine on a loop needs a bound, or one dry provider mails staff thousands of times. `provider_credits_exhausted` is deduped per org per calendar day (`ORG_DAILY_EVENTS` in `src/routes/send.ts`); the key holds neither recipient nor user, so a caller with no acting user deduplicates exactly like one with one. It also refuses `recipientEmail`/`bccEmails`/`ccEmails` on **both** routes (`STAFF_ONLY_DELIVERY_EVENTS`) — `/platform-send` already rejects them, `/send` did not — and 400s when `metadata.provider` or `metadata.reason` is blank, because an alert naming no provider is a staff email with blanks where the facts belong. `campaign_failing` (campaign-service, a campaign failing every run) has the same shape keyed on the CAMPAIGN per day (`CAMPAIGN_DAILY_EVENTS`); campaign-service latches it once per failing episode, this key is the backstop. `audience_refill_failed` (campaign-service, out of people and the automatic refill gave nobody new) shares that per-campaign-day bound on its own key. `trigger_silent` (campaign-service, a reactive trigger silent for days) is FLEET-WIDE: keyed per TRIGGER per day with NO org (`TRIGGER_DAILY_EVENTS`), and in `NO_ACTOR_EVENTS` (the `x-user-id` is billing context, never an actor, so the self-action skip never drops it).
- `POST /platform-staff-alert` (`handlePlatformStaffAlert` in `src/routes/send.ts`) is a staff alert about a PLATFORM fact no org owns (today only `sending_domain_blocklisted`, DOMAIN-BLOCKLIST-1016, from instantly-service; `inbox_placement_below_bar` was retired 2026-10-22 with its template row, migration 0022: inbox placement is watched on dashboard v2 Monitoring, never mailed, so do not bring it back): API key only, refuses `x-org-id`/`x-user-id`, staff list only (`ADMIN_EMAILS`), platform run, once per caller `eventId` (dedup key per recipient; a `failed` row is reclaimed by the next call, a `sent` one answers `duplicate`). Closed list + required metadata in `src/lib/platform-staff-alerts.ts`.
- `POST /platform-orgless-send` (`handleOrglessPlatformSend` in `src/routes/send.ts`) mails a person who has NO account yet: no org, no user, platform-paid at every hop (platform run, email-gateway `POST /platform/send` with no `x-org-id`/`x-user-id`, always the transactional stream), never deduplicated, no Cc/Bcc (no founder copy: a one-time code reaches only its owner), `email_events.org_id` NULL. Closed allowlist + required metadata in `src/lib/orgless-events.ts` (today only client-service's `agent_signup_code`). Adding a name there is a decision to mail anyone at our expense: keep it to "the recipient has no org yet".
- `src/lib/runs-client.ts` — Runs service client (create/update runs)
- `src/lib/brand-transfer.ts` — this service's half of the fleet `POST /internal/transfer-brand`. Only `email_events` holds a brand. A row is tied to one in three ways, and all three must move: `brand_ids`, `metadata.brandId` (brand_daily_budget_changed records it nowhere else), or a campaign in `campaign_id` / `metadata.campaignId` with no brand at all (campaign_created, campaign_stopped, campaign-error: 507 such rows in prod on 2026-09-27). The campaign → brand mapping is read from campaign-service (`src/lib/campaign-service.ts`), never guessed. The source org also lives in `metadata.orgId` and the `dedup_key` prefix, and both move with the row. A brand rewrite is scoped to the target org, because a brand id is shared across orgs.
- `src/lib/trace-event.ts` — Fire-and-forget event tracing to runs-service
- `src/lib/suppression.ts` — Reads the Postmark **broadcast stream's suppression list** (the platform token + stream id come from key-service). This is the ONLY authoritative opt-out source for mailing lists — do NOT substitute postmark-service's `/orgs/status` mirror: it is org-scoped and only covers addresses already messaged under that org, so it reports a suppressed address as subscribed (verified in prod 2026-08-02 on an address Postmark had suppressed as a HardBounce since June). This service stores no opt-out flag of its own. Two cost rules hold the read down and must not be undone: it passes Postmark's `EmailAddress` filter so only the list's own addresses are read (an unfiltered `/suppressions/dump` grows with **total** outreach volume on the shared broadcast stream, not with the list), and credentials + per-address answers sit in a short in-process cache (5 min / 1 min). **A send passes `maxAgeMs: 0` and must keep doing so** — it re-checks every recipient against Postmark, so an address that opted out after a page load cached it as subscribed is still skipped. A failed lookup throws and caches nothing.
- `src/lib/why.ts` — distribute.you's why, "Revenue made easy." (owner, frozen 2026-10-03), signed under every customer-facing email at render (`signRendered` in `send.ts`) and every mailing-list update (`resolveBody`, with a "Get started: distribute.you" link). Skipped on staff-routed events and on a template whose own `from` is outside distribute.you (GrowthAgency.dev legacy); never doubled. Do not move it into templates: their owners are spread across the fleet. `POST /send/preview` shows a lifecycle email exactly as sent.
- `src/lib/brand-layout.ts` — distribute.you's email chrome, a byte copy of the dashboard's `emailLayout()`. `signRendered` in `send.ts` wraps a customer template's rendered body in it when the template's `layout` column is `brand` (default) and the body is not a full HTML document (checked AFTER interpolation, so `{{html}}` carrying a document stays untouched); text part gets `--\ndistribute.you\nRevenue made easy.`. Staff-inbox templates are `layout = 'none'` (migration 0019 set instantly-service's four; `PUT /templates` without `layout` keeps the stored value). If the dashboard restyles its layout, copy it here in the same ship, or customer emails split into two looks.
- `src/lib/delivery-stream.ts` — a template's `stream` (column `email_templates.stream`, `PUT /templates` field). `"transactional"` = person-to-person mail the recipient answers with Reply: forwarded to email-gateway as `stream: "transactional"` (Postmark transactional stream, no List-Unsubscribe, no footer) and sent exactly as registered — `signRendered` adds no layout and no why, because the reply quotes the message into the customer's own conversation with their prospect. `"broadcast"` (default) puts no `stream` on the wire. Never for anything a recipient can ask to stop; mailing-list sends never pass it. Own module because tests `vi.mock` `email-gateway.js` whole.
- `src/lib/address-blob.ts` — Lenient parser for a pasted blob of addresses
- `src/lib/mailing-list-body.ts` — Markdown → HTML for mailing-list update bodies. Adds NO unsubscribe markup: email-gateway's `appendSignature` already appends a discreet `{{{pm:unsubscribe}}}` footer to every transactional HTML body, and Postmark resolves it against the broadcast stream. Adding one here renders a duplicate link. Also rejects SVG images (`findUnrenderableImages`) — Gmail, Outlook and Yahoo refuse `image/svg+xml` and show the alt text in a broken placeholder.
- `src/db/schema.ts` — Drizzle schema (`email_events`, `email_templates`, `mailing_lists`, `mailing_list_subscribers`, `mailing_list_updates`)
- `src/db/index.ts` — Database connection
- `src/templates/index.ts` — Renderer + DB resolver (`{{var}}` interpolation, DB lookup by `name`). Product template **content is NOT stored in this repo** (staff alerts excepted, see `staff-alerts.ts` above) — each consuming app declares its own templates and registers them at startup via `PUT /templates` (authed) or `PUT /platform-templates` (api-key only). Hardcoded templates were removed in PR #49 (commit `2eaf1d0`). To add a new template for the Distribute product, edit `distribute.you/apps/dashboard/src/instrumentation.ts` `EMAIL_TEMPLATES` array — NOT this repo.
- `scripts/generate-openapi.ts` — OpenAPI spec generation script
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually

## Email HTML

Anything this service puts in an `htmlBody` is read in Gmail, Apple Mail and Outlook, not a browser. Two rules follow, and both have already cost a round here:

- **Style every element inline.** Gmail discards `<head>` and any `<style>` block; Outlook's Word engine ignores most of what survives. A stylesheet renders correctly in a browser preview and arrives unstyled in the inbox, which makes the defect easy to believe is fixed when it is not. No `class`, no custom properties, no flexbox, grid or positioning. Layout is nested tables — table geometry is the one thing every client agrees on.
- **Verify a phone claim by measuring at 375px, not by eyeballing a screenshot at a convenient width.** Render the HTML and assert `scrollWidth - clientWidth === 0` at 375px (iPhone SE/mini, the narrowest common screen). A 390px screenshot that looks fine hides a real overflow: #115 shipped a table that read clean at 390px and pushed the document to 401px at 375px, which #116 then had to fix with `table-layout:fixed` and stated percentage column widths. Under the default automatic layout a table is never narrower than its content, and because the shell is built from tables, one wide row side-scrolls the whole message.
