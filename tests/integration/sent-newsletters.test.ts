import request from "supertest";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// UNIBOX-NEWSLETTER-1113: every newsletter email a release SENT one subscriber is served for the
// subscriber's Unibox thread, exactly once, oldest first; an unsent row never is.

import app from "../../src/index.js";
import { db, sql } from "../../src/db/index.js";
import { mailingLists, mailingListReleases, mailingListReleaseRecipients } from "../../src/db/schema.js";

const API_KEY = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY!;
const ORG = "4a7e2c1d-9b3f-4e6a-8c2d-1f0e9d8c7b6a";
const BRAND = "6b1d3e5f-7a9c-4b2d-8e4f-0a1b2c3d4e5f";

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
});

beforeEach(async () => {
  await sql`TRUNCATE mailing_list_release_recipients, mailing_list_releases, mailing_lists CASCADE`;
});

afterAll(async () => {
  await sql`TRUNCATE mailing_list_release_recipients, mailing_list_releases, mailing_lists CASCADE`;
  await sql.end();
});

async function release(listId: string, subject: string, runId: string, brandIds: string[] | null = null) {
  const [r] = await db
    .insert(mailingListReleases)
    .values({
      listId, subject, fromAddress: "Kevin <kevin@x.com>", bodyKind: "markdown", htmlBody: "<p>h</p>", textBody: "h",
      dedupKey: runId, dailyLimit: 100, status: "running", recipientCount: 2, orgId: ORG, userId: "user", runId, brandIds,
    })
    .returning();
  return r;
}

async function feed(query: Record<string, string> = {}) {
  const res = await request(app).get("/internal/sent-newsletters").query(query).set("x-api-key", API_KEY);
  expect(res.status).toBe(200);
  return res.body as { emails: Array<Record<string, any>>; nextCursor: string | null };
}

describe("GET /internal/sent-newsletters", () => {
  it("requires the API key", async () => {
    const res = await request(app).get("/internal/sent-newsletters");
    expect(res.status).toBe(401);
  });

  it("serves each sent email once, oldest first, with its subject; never an unsent row", async () => {
    const [list] = await db.insert(mailingLists).values({ slug: "newsletter" }).returning();
    const first = await release(list.id, "First issue", "5e5e5e5e-1111-4000-a000-000000000001");
    const second = await release(list.id, "Second issue", "5e5e5e5e-1111-4000-a000-000000000002", [BRAND]);
    await db.insert(mailingListReleaseRecipients).values([
      { releaseId: first.id, email: "a@x.com", status: "sent", settledAt: new Date("2026-10-26T22:07:25.748Z") },
      { releaseId: first.id, email: "b@x.com", status: "skipped_undeliverable", settledAt: new Date("2026-10-26T22:07:26Z") },
      { releaseId: second.id, email: "a@x.com", status: "sent", settledAt: new Date("2026-11-02T04:00:02.503Z") },
      { releaseId: second.id, email: "b@x.com", status: "cancelled", settledAt: new Date("2026-11-02T04:00:03Z") },
      { releaseId: second.id, email: "c@x.com", status: "pending" },
    ]);

    const page = await feed();
    expect(page.emails.map((e) => [e.recipientEmail, e.subject, e.sentAt])).toEqual([
      ["a@x.com", "First issue", "2026-10-26T22:07:25.748Z"],
      ["a@x.com", "Second issue", "2026-11-02T04:00:02.503Z"],
    ]);
    expect(page.emails[0]).toMatchObject({ releaseId: first.id, listSlug: "newsletter", orgId: ORG, brandIds: null, from: "Kevin <kevin@x.com>" });
    expect(page.emails[1].brandIds).toEqual([BRAND]);

    // Paging: one at a time, then an empty page that returns the cursor sent.
    const p1 = await feed({ limit: "1" });
    expect(p1.emails).toHaveLength(1);
    const p2 = await feed({ limit: "1", after: p1.nextCursor! });
    expect(p2.emails[0].subject).toBe("Second issue");
    const p3 = await feed({ after: p2.nextCursor! });
    expect(p3.emails).toEqual([]);
    expect(p3.nextCursor).toBe(p2.nextCursor);
  });

  it("refuses a cursor it never returned", async () => {
    const res = await request(app).get("/internal/sent-newsletters").query({ after: "garbage" }).set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
  });
});
