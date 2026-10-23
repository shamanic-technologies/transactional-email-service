import { vi, beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";

vi.mock("../../src/lib/runs-client.js", () => ({ declareOutcomesBatch: vi.fn() }));

import { db, sql } from "../../src/db/index.js";
import { mailingLists, mailingListSubscribers, mailingListReleases, mailingListReleaseRecipients } from "../../src/db/schema.js";
import { readPastReleaseSends, LIVE_SUBJECTS_SINCE } from "../../src/lib/outcome-backfill.js";

const RUN_ID = "5e5e5e5e-0000-4000-a000-000000000001";

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
});

beforeEach(async () => {
  await sql`TRUNCATE mailing_list_release_recipients, mailing_list_releases, mailing_list_subscribers, mailing_lists CASCADE`;
});

afterAll(async () => {
  await sql`TRUNCATE mailing_list_release_recipients, mailing_list_releases, mailing_list_subscribers, mailing_lists CASCADE`;
});

describe("readPastReleaseSends", () => {
  it("reads every sent recipient settled before the live path, keyed on its subscriber row", async () => {
    const [list] = await db.insert(mailingLists).values({ slug: "backfill-fixture" }).returning();
    const subs = await db
      .insert(mailingListSubscribers)
      .values(["a@x.com", "b@x.com", "c@x.com", "d@x.com"].map((email) => ({ listId: list.id, email })))
      .returning();
    const [release] = await db
      .insert(mailingListReleases)
      .values({
        listId: list.id, subject: "s", fromAddress: "f@x.com", bodyKind: "markdown", htmlBody: "<p>h</p>", textBody: "h",
        dedupKey: "d", dailyLimit: 100, status: "running", recipientCount: 5, orgId: "org", userId: "user", runId: RUN_ID,
      })
      .returning();
    const before = new Date(LIVE_SUBJECTS_SINCE.getTime() - 60_000);
    const after = new Date(LIVE_SUBJECTS_SINCE.getTime() + 60_000);
    await db.insert(mailingListReleaseRecipients).values([
      { releaseId: release.id, email: "a@x.com", status: "sent", settledAt: before },
      { releaseId: release.id, email: "b@x.com", status: "sent", settledAt: after },
      { releaseId: release.id, email: "c@x.com", status: "skipped_undeliverable", settledAt: before },
      { releaseId: release.id, email: "d@x.com", status: "failed", settledAt: before },
      { releaseId: release.id, email: "gone@x.com", status: "sent", settledAt: before },
    ]);

    const sends = await readPastReleaseSends();
    expect(sends).toEqual([{ runId: RUN_ID, subscriberId: subs[0].id, settledAt: before }]);
  });
});
