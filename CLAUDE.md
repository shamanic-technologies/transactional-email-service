# Project: Transactional Email Service

Transactional email service that sends event-triggered emails. Resolves recipients via Clerk, deduplicates sends, renders HTML/text templates, and delivers via the Email Gateway.

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
- `src/routes/` — Route handlers (`send.ts`, `stats.ts`, `health.ts`, `openapi.ts`)
- `src/middleware/auth.ts` — API key authentication
- `src/lib/clerk.ts` — Clerk user/org email resolution
- `src/lib/email-gateway.ts` — Email Gateway client
- `src/lib/runs-client.ts` — Runs service client (create/update runs)
- `src/db/schema.ts` — Drizzle schema (`email_events` table)
- `src/db/index.ts` — Database connection
- `src/templates/` — Email templates (HTML + text), organized by app (`distribute/`)
- `scripts/generate-openapi.ts` — OpenAPI spec generation script
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually
