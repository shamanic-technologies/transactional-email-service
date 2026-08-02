# Project: Transactional Email Service

Transactional email service that sends event-triggered emails. Resolves recipients via client-service, deduplicates sends, renders HTML/text templates, and delivers via the Email Gateway.

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
- `src/routes/` — Route handlers (`send.ts`, `stats.ts`, `health.ts`, `openapi.ts`, `templates.ts`, `transfer-brand.ts`, `mailing-lists.ts`)
- `src/middleware/auth.ts` — API key + identity-header authentication
- `src/lib/client-service.ts` — client-service user email resolution
- `src/lib/email-gateway.ts` — Email Gateway client
- `src/lib/runs-client.ts` — Runs service client (create/update runs)
- `src/lib/trace-event.ts` — Fire-and-forget event tracing to runs-service
- `src/lib/suppression.ts` — Reads the Postmark **broadcast stream's suppression list** (the platform token + stream id come from key-service). This is the ONLY authoritative opt-out source for mailing lists — do NOT substitute postmark-service's `/orgs/status` mirror: it is org-scoped and only covers addresses already messaged under that org, so it reports a suppressed address as subscribed (verified in prod 2026-08-02 on an address Postmark had suppressed as a HardBounce since June). This service stores no opt-out flag of its own. Two cost rules hold the read down and must not be undone: it passes Postmark's `EmailAddress` filter so only the list's own addresses are read (an unfiltered `/suppressions/dump` grows with **total** outreach volume on the shared broadcast stream, not with the list), and credentials + per-address answers sit in a short in-process cache (5 min / 1 min). **A send passes `maxAgeMs: 0` and must keep doing so** — it re-checks every recipient against Postmark, so an address that opted out after a page load cached it as subscribed is still skipped. A failed lookup throws and caches nothing.
- `src/lib/address-blob.ts` — Lenient parser for a pasted blob of addresses
- `src/lib/mailing-list-body.ts` — Markdown → HTML for mailing-list update bodies. Adds NO unsubscribe markup: email-gateway's `appendSignature` already appends a discreet `{{{pm:unsubscribe}}}` footer to every transactional HTML body, and Postmark resolves it against the broadcast stream. Adding one here renders a duplicate link. `POST /mailing-lists/updates/preview` renders a draft through this same `renderUpdateBody` the send calls, and a test pins the two byte-equal — a preview rendered by a second implementation (the admin console had one) drifts away from the send the first time either changes, which is the whole reason the endpoint exists. Also rejects SVG images (`findUnrenderableImages`) — Gmail, Outlook and Yahoo refuse `image/svg+xml` and show the alt text in a broken placeholder.
- `src/db/schema.ts` — Drizzle schema (`email_events`, `email_templates`, `mailing_lists`, `mailing_list_subscribers`, `mailing_list_updates`)
- `src/db/index.ts` — Database connection
- `src/templates/index.ts` — Renderer + DB resolver (`{{var}}` interpolation, DB lookup by `name`). Template **content is NOT stored in this repo** — each consuming app declares its own templates and registers them at startup via `PUT /templates` (authed) or `PUT /platform-templates` (api-key only). Hardcoded templates were removed in PR #49 (commit `2eaf1d0`). To add a new template for the Distribute product, edit `distribute.you/apps/dashboard/src/instrumentation.ts` `EMAIL_TEMPLATES` array — NOT this repo.
- `scripts/generate-openapi.ts` — OpenAPI spec generation script
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually

## Email HTML

Anything this service puts in an `htmlBody` is read in Gmail, Apple Mail and Outlook, not a browser. Two rules follow, and both have already cost a round here:

- **Style every element inline.** Gmail discards `<head>` and any `<style>` block; Outlook's Word engine ignores most of what survives. A stylesheet renders correctly in a browser preview and arrives unstyled in the inbox, which makes the defect easy to believe is fixed when it is not. No `class`, no custom properties, no flexbox, grid or positioning. Layout is nested tables — table geometry is the one thing every client agrees on.
- **Verify a phone claim by measuring at 375px, not by eyeballing a screenshot at a convenient width.** Render the HTML and assert `scrollWidth - clientWidth === 0` at 375px (iPhone SE/mini, the narrowest common screen). A 390px screenshot that looks fine hides a real overflow: #115 shipped a table that read clean at 390px and pushed the document to 401px at 375px, which #116 then had to fix with `table-layout:fixed` and stated percentage column widths. Under the default automatic layout a table is never narrower than its content, and because the shell is built from tables, one wide row side-scrolls the whole message.
