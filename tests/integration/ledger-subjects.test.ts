import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { db, sql } from "../../src/db/index.js";
import { mailingLists, mailingListSubscribers, mailingListReleases, mailingListReleaseRecipients } from "../../src/db/schema.js";
import { readAddressSubjects } from "../../src/lib/ledger-subjects.js";

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
});

beforeEach(async () => {
  await sql`TRUNCATE mailing_list_release_recipients, mailing_list_releases, mailing_list_subscribers, mailing_lists CASCADE`;
});

afterAll(async () => {
  await sql`TRUNCATE mailing_list_release_recipients, mailing_list_releases, mailing_list_subscribers, mailing_lists CASCADE`;
});

async function release(listId: string, runId: string) {
  const [r] = await db
    .insert(mailingListReleases)
    .values({
      listId, subject: "s", fromAddress: "f@x.com", bodyKind: "markdown", htmlBody: "<p>h</p>", textBody: "h",
      dedupKey: runId, dailyLimit: 100, status: "running", recipientCount: 1, orgId: "org", userId: "user", runId,
    })
    .returning();
  return r;
}

describe("readAddressSubjects", () => {
  it("names one subscriber per address: the list whose release verified it first", async () => {
    const [a] = await db.insert(mailingLists).values({ slug: "list-a" }).returning();
    const [b] = await db.insert(mailingLists).values({ slug: "list-b" }).returning();
    // Subscribed to A first, but B's release checked it first.
    const [shareA] = await db.insert(mailingListSubscribers).values({ listId: a.id, email: "both@x.com", createdAt: new Date("2026-09-01T00:00:00Z") }).returning();
    const [shareB] = await db.insert(mailingListSubscribers).values({ listId: b.id, email: "both@x.com", createdAt: new Date("2026-09-02T00:00:00Z") }).returning();
    const [onlyA] = await db.insert(mailingListSubscribers).values({ listId: a.id, email: "only@x.com" }).returning();
    // On both lists, checked by nobody: the oldest subscriber row.
    const [neverA] = await db.insert(mailingListSubscribers).values({ listId: a.id, email: "never@x.com", createdAt: new Date("2026-09-01T00:00:00Z") }).returning();
    await db.insert(mailingListSubscribers).values({ listId: b.id, email: "never@x.com", createdAt: new Date("2026-09-03T00:00:00Z") });

    const relA = await release(a.id, "5e5e5e5e-0000-4000-a000-00000000000a");
    const relB = await release(b.id, "5e5e5e5e-0000-4000-a000-00000000000b");
    await db.insert(mailingListReleaseRecipients).values([
      { releaseId: relB.id, email: "both@x.com", status: "sent", claimedAt: new Date("2026-10-01T00:00:00Z"), verdict: "valid", verificationId: "v1" },
      { releaseId: relA.id, email: "both@x.com", status: "sent", claimedAt: new Date("2026-10-05T00:00:00Z"), verdict: "valid", verificationId: "v1" },
      { releaseId: relA.id, email: "never@x.com", status: "sent", claimedAt: new Date("2026-09-20T00:00:00Z") },
    ]);

    const subjects = await readAddressSubjects();
    expect(subjects).toEqual([
      { email: "both@x.com", subscriberId: shareB.id },
      { email: "never@x.com", subscriberId: neverA.id },
      { email: "only@x.com", subscriberId: onlyA.id },
    ]);
    expect(shareA.id).not.toBe(shareB.id);
  });
});
