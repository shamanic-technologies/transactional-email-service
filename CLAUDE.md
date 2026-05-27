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
- `src/routes/` — Route handlers (`send.ts`, `stats.ts`, `health.ts`, `openapi.ts`, `templates.ts`, `transfer-brand.ts`)
- `src/middleware/auth.ts` — API key + identity-header authentication
- `src/lib/client-service.ts` — client-service user email resolution
- `src/lib/email-gateway.ts` — Email Gateway client
- `src/lib/runs-client.ts` — Runs service client (create/update runs)
- `src/lib/trace-event.ts` — Fire-and-forget event tracing to runs-service
- `src/db/schema.ts` — Drizzle schema (`email_events` table)
- `src/db/index.ts` — Database connection
- `src/templates/index.ts` — Renderer + DB resolver (`{{var}}` interpolation, DB lookup by `name`). Template **content is NOT stored in this repo** — each consuming app declares its own templates and registers them at startup via `PUT /templates` (authed) or `PUT /platform-templates` (api-key only). Hardcoded templates were removed in PR #49 (commit `2eaf1d0`). To add a new template for the Distribute product, edit `distribute.you/apps/dashboard/src/instrumentation.ts` `EMAIL_TEMPLATES` array — NOT this repo.
- `scripts/generate-openapi.ts` — OpenAPI spec generation script
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually
