import request from "supertest";
import { vi, beforeAll, beforeEach, afterAll, afterEach, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// Mock external services before app imports
vi.mock("../../src/lib/client-service.js", () => ({
  resolveUserEmail: vi.fn().mockResolvedValue("user@test.com"),
}));

vi.mock("../../src/lib/email-gateway.js", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/lib/suppression.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  fetchSuppressed: vi.fn(),
}));

vi.mock("../../src/lib/release-health.js", () => ({
  fetchDeliveryOutcomes: vi.fn(),
}));

import app from "../../src/index.js";
import { db, sql } from "../../src/db/index.js";
import { sendEmail } from "../../src/lib/email-gateway.js";
import { createRun } from "../../src/lib/runs-client.js";
import { fetchSuppressed } from "../../src/lib/suppression.js";
import { fetchDeliveryOutcomes } from "../../src/lib/release-health.js";
import { resetReleaseWorkerState, runReleaseTick } from "../../src/lib/release-worker.js";
import { seedStaffTemplates } from "../../src/templates/staff-alerts.js";
import { MAX_TICK_BATCH } from "../../src/lib/release-pacing.js";

const API_KEY = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY!;
const AUTH = { "x-api-key": API_KEY, "x-org-id": "org_test", "x-user-id": "user_staff" };

/** A fixture list of a few hundred addresses, which is the size the acceptance asks for. */
const LIST_SIZE = 250;
const SLUG = "fixture-newsletter";

function addresses(count = LIST_SIZE): string[] {
  return Array.from({ length: count }, (_, i) => `member${String(i).padStart(4, "0")}@example.com`);
}

/** Who a mocked gateway was actually asked to mail, in the order it was asked. */
function mailed(): string[] {
  return vi
    .mocked(sendEmail)
    .mock.calls.map(([params]) => params.to);
}

function nobodySuppressed() {
  return { isSuppressed: () => false, reasonFor: () => null };
}

/** A suppression answer that suppresses exactly the addresses named. */
function suppressing(...emails: string[]) {
  const set = new Set(emails);
  return {
    isSuppressed: (email: string) => set.has(email),
    reasonFor: (email: string) => (set.has(email) ? "ManualSuppression" : null),
  };
}

async function seedList(size = LIST_SIZE): Promise<void> {
  await request(app)
    .post(`/mailing-lists/${SLUG}/subscribers`)
    .set(AUTH)
    .send({ raw: addresses(size).join("\n") })
    .expect(200);
}

async function createRelease(body: Record<string, unknown>) {
  return request(app).post(`/mailing-lists/${SLUG}/releases`).set(AUTH).send(body);
}

async function tick() {
  return runReleaseTick();
}

/**
 * Tick until the worker has nothing left to do right now.
 *
 * A tick deliberately takes only a slice — the day's allowance spread over the
 * ticks left in the day — so draining a release means many passes, exactly as
 * it does in production over a day of one-minute wake-ups. The loop stops on
 * the first tick that moves nothing, which is either "today's allowance is
 * spent" or "this release is over".
 */
async function drain(maxTicks = 3000): Promise<number> {
  let ticks = 0;
  for (; ticks < maxTicks; ticks++) {
    const report = await tick();
    if (report.sent === 0 && report.failed === 0 && report.skippedOptedOut === 0) break;
  }
  return ticks;
}

async function readRelease(releaseId: string) {
  const res = await request(app).get(`/mailing-lists/releases/${releaseId}`).set(AUTH).expect(200);
  return res.body;
}

let runSeq = 0;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
  await seedStaffTemplates();
}, 20000);

beforeEach(async () => {
  await sql`TRUNCATE TABLE mailing_lists CASCADE`;
  resetReleaseWorkerState();

  vi.mocked(sendEmail).mockReset();
  vi.mocked(sendEmail).mockResolvedValue(undefined);
  vi.mocked(fetchSuppressed).mockReset();
  vi.mocked(fetchSuppressed).mockResolvedValue(nobodySuppressed());
  vi.mocked(fetchDeliveryOutcomes).mockReset();
  vi.mocked(fetchDeliveryOutcomes).mockResolvedValue({ sent: 0, bounced: 0, unsubscribed: 0 });
  vi.mocked(createRun).mockReset();
  vi.mocked(createRun).mockImplementation(async () => {
    runSeq += 1;
    return { id: `11111111-2222-4333-8444-${String(runSeq).padStart(12, "0")}` } as any;
  });
});

afterEach(() => {
  resetReleaseWorkerState();
});

afterAll(async () => {
  await sql`TRUNCATE TABLE mailing_lists CASCADE`;
  await sql.end();
});

describe("creating a release", () => {
  it("answers immediately, sends nothing, and states what it covers and the pace it will follow", async () => {
    await seedList();

    const started = Date.now();
    const res = await createRelease({ subject: "September update", body: "# Hello", dailyLimit: 100 });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.recipientCount).toBe(LIST_SIZE);
    expect(res.body.dailyLimit).toBe(100);
    expect(res.body.estimatedDays).toBe(3);
    expect(res.body.status).toBe("running");
    expect(res.body.reached).toBe(0);
    expect(res.body.remaining).toBe(LIST_SIZE);

    // Nothing left during the request. That is the whole point of a release.
    expect(sendEmail).not.toHaveBeenCalled();
    // Generous by design: the assertion is that creating a release does not
    // walk the list, not that this machine is fast.
    expect(elapsed).toBeLessThan(5000);
  });

  it("writes one ledger row per address, which is what progress is counted from", async () => {
    await seedList();
    const res = await createRelease({ subject: "Ledger", body: "hi", dailyLimit: 10 });

    const rows = await sql`
      SELECT count(*)::int AS n FROM mailing_list_release_recipients WHERE release_id = ${res.body.releaseId}
    `;
    expect(rows[0].n).toBe(LIST_SIZE);
  });

  it("refuses a body carrying an image no mail client renders, before anybody is written down", async () => {
    await seedList(3);
    const res = await createRelease({
      subject: "Broken",
      body: "![logo](https://cdn.example.com/logo.svg)",
      dailyLimit: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("SVG");
  });

  it("refuses a daily limit larger than the worker can actually deliver in a day", async () => {
    await seedList(3);
    const res = await createRelease({ subject: "Too fast", body: "hi", dailyLimit: 1_000_000 });

    expect(res.status).toBe(400);
  });

  it("refuses a list that does not exist", async () => {
    const res = await request(app)
      .post("/mailing-lists/no-such-list/releases")
      .set(AUTH)
      .send({ subject: "x", body: "y", dailyLimit: 1 });

    expect(res.status).toBe(404);
  });
});

describe("issuing the same release twice", () => {
  it("returns the release the first request created rather than starting a second one", async () => {
    await seedList(20);
    const body = { subject: "Same update", body: "identical bytes", dailyLimit: 5 };

    const first = await createRelease(body);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);

    const second = await createRelease(body);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.releaseId).toBe(first.body.releaseId);

    const releases = await sql`SELECT count(*)::int AS n FROM mailing_list_releases`;
    expect(releases[0].n).toBe(1);
  });

  it("does not double-mail anyone when it is issued again mid-release", async () => {
    await seedList(20);
    const body = { subject: "Retried", body: "identical bytes", dailyLimit: 20 };

    await createRelease(body);
    await tick();
    await createRelease(body);
    await drain();

    const sent = mailed();
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent.length).toBe(20);
  });

  it("lets staff deliberately send the same update again once the first release has ended", async () => {
    await seedList(5);
    const body = { subject: "Again", body: "same", dailyLimit: 5 };

    const first = await createRelease(body);
    await request(app).post(`/mailing-lists/releases/${first.body.releaseId}/cancel`).set(AUTH).expect(200);

    const second = await createRelease(body);
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(true);
    expect(second.body.releaseId).not.toBe(first.body.releaseId);
  });
});

describe("pacing", () => {
  it("never sends more than the daily limit in one UTC day, however often it is ticked", async () => {
    await seedList(LIST_SIZE);
    const dailyLimit = 40;
    const created = await createRelease({ subject: "Paced", body: "hi", dailyLimit });

    await drain();

    expect(mailed().length).toBe(dailyLimit);

    const progress = await readRelease(created.body.releaseId);
    expect(progress.reached).toBe(dailyLimit);
    expect(progress.todayUsed).toBe(dailyLimit);
    expect(progress.remaining).toBe(LIST_SIZE - dailyLimit);
    expect(progress.status).toBe("running");
  });

  it("takes no more than the tick ceiling in one pass", async () => {
    await seedList(LIST_SIZE);
    await createRelease({ subject: "Ceiling", body: "hi", dailyLimit: LIST_SIZE });

    const report = await tick();
    expect(report.sent).toBeLessThanOrEqual(MAX_TICK_BATCH);
  });

  it("completes and closes its run once every address is accounted for", async () => {
    await seedList(10);
    const created = await createRelease({ subject: "Short", body: "hi", dailyLimit: 10 });

    await drain();

    const progress = await readRelease(created.body.releaseId);
    expect(progress.status).toBe("completed");
    expect(progress.reached).toBe(10);
    expect(progress.remaining).toBe(0);
    expect(progress.completedAt).not.toBeNull();
  });
});

describe("a release survives a restart", () => {
  it("loses nobody and repeats nobody when the process is replaced mid-flight", async () => {
    await seedList(LIST_SIZE);
    await createRelease({ subject: "Restarted", body: "hi", dailyLimit: LIST_SIZE });

    // Some of the release goes out, then the process is replaced: every scrap
    // of in-memory state is dropped and the worker starts again from the
    // ledger alone.
    await tick();
    await tick();
    await tick();
    const beforeRestart = mailed().length;
    expect(beforeRestart).toBeGreaterThan(0);

    resetReleaseWorkerState();

    await drain();

    const sent = mailed();
    expect(sent.length).toBeGreaterThan(beforeRestart);
    // Nobody twice.
    expect(new Set(sent).size).toBe(sent.length);
    // Nobody lost.
    expect(new Set(sent)).toEqual(new Set(addresses(LIST_SIZE)));
  });

  it("accounts for an address whose claim outlived the worker holding it, and never re-sends it", async () => {
    await seedList(20);
    const created = await createRelease({ subject: "Killed", body: "hi", dailyLimit: 20 });
    const releaseId = created.body.releaseId;

    // A worker that was killed between claiming an address and learning the
    // outcome leaves exactly this behind.
    const [stranded] = await sql`
      UPDATE mailing_list_release_recipients
      SET status = 'sending', claimed_at = now() - interval '2 hours'
      WHERE id IN (SELECT id FROM mailing_list_release_recipients WHERE release_id = ${releaseId} LIMIT 1)
      RETURNING email
    `;

    await drain();

    const progress = await readRelease(releaseId);
    expect(progress.failed).toBe(1);
    expect(progress.reached).toBe(19);
    expect(progress.remaining).toBe(0);
    // Never re-sent: this service cannot ask the provider whether that one
    // message left, and mailing somebody twice is the worse outcome.
    expect(mailed()).not.toContain(stranded.email);

    const [row] = await sql`
      SELECT reason FROM mailing_list_release_recipients
      WHERE release_id = ${releaseId} AND email = ${stranded.email}
    `;
    expect(row.reason).toContain("stopped between claiming");
  });
});

describe("pause, resume and cancel", () => {
  it("pauses within a tick, resumes where it stopped, and repeats nobody across the gap", async () => {
    await seedList(LIST_SIZE);
    const created = await createRelease({ subject: "Stoppable", body: "hi", dailyLimit: LIST_SIZE });
    const releaseId = created.body.releaseId;

    await tick();
    const duringFirstRun = mailed().length;

    await request(app).post(`/mailing-lists/releases/${releaseId}/pause`).set(AUTH).expect(200);

    await tick();
    await tick();
    expect(mailed().length).toBe(duringFirstRun);
    expect((await readRelease(releaseId)).status).toBe("paused");

    await request(app).post(`/mailing-lists/releases/${releaseId}/resume`).set(AUTH).expect(200);

    await tick();
    expect(mailed().length).toBeGreaterThan(duringFirstRun);
    expect(new Set(mailed()).size).toBe(mailed().length);
  });

  it("cancels for good: it sends nothing more, never resumes, and says so for every waiting address", async () => {
    await seedList(50);
    const created = await createRelease({ subject: "Cancelled", body: "hi", dailyLimit: 50 });
    const releaseId = created.body.releaseId;

    await tick();
    const beforeCancel = mailed().length;

    await request(app).post(`/mailing-lists/releases/${releaseId}/cancel`).set(AUTH).expect(200);

    await drain();
    expect(mailed().length).toBe(beforeCancel);

    const resumed = await request(app).post(`/mailing-lists/releases/${releaseId}/resume`).set(AUTH);
    expect(resumed.status).toBe(409);
    expect(resumed.body.error).toContain("never resumes");

    const progress = await readRelease(releaseId);
    expect(progress.status).toBe("cancelled");
    expect(progress.remaining).toBe(0);

    const [pending] = await sql`
      SELECT count(*)::int AS n FROM mailing_list_release_recipients
      WHERE release_id = ${releaseId} AND status = 'pending'
    `;
    expect(pending.n).toBe(0);
  });

  it("refuses to pause a release that is not running", async () => {
    await seedList(5);
    const created = await createRelease({ subject: "x", body: "y", dailyLimit: 5 });
    const releaseId = created.body.releaseId;

    await request(app).post(`/mailing-lists/releases/${releaseId}/pause`).set(AUTH).expect(200);
    const again = await request(app).post(`/mailing-lists/releases/${releaseId}/pause`).set(AUTH);
    expect(again.status).toBe(409);
  });

  it("answers 404 for a release that does not exist", async () => {
    const res = await request(app)
      .get("/mailing-lists/releases/11111111-2222-4333-8444-999999999999")
      .set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe("provider suppression is reconciled per slice", () => {
  it("does not mail somebody who unsubscribed after the release started", async () => {
    await seedList(LIST_SIZE);
    await createRelease({ subject: "Respectful", body: "hi", dailyLimit: LIST_SIZE });

    // Day one: nobody is suppressed.
    await tick();
    const dayOne = mailed();
    expect(dayOne.length).toBeGreaterThan(0);

    // Somebody who has not been reached yet unsubscribes.
    const notYetMailed = addresses(LIST_SIZE).find((email) => !dayOne.includes(email))!;
    vi.mocked(fetchSuppressed).mockResolvedValue(suppressing(notYetMailed));

    await drain();

    expect(mailed()).not.toContain(notYetMailed);

    const [row] = await sql`
      SELECT status, reason FROM mailing_list_release_recipients WHERE email = ${notYetMailed}
    `;
    expect(row.status).toBe("skipped_opted_out");
    expect(row.reason).toBe("ManualSuppression");
  });

  it("asks the provider with no reuse at all, so an answer cached a moment ago cannot stand in", async () => {
    await seedList(20);
    await createRelease({ subject: "Fresh", body: "hi", dailyLimit: 20 });

    await tick();

    const [, , , options] = vi.mocked(fetchSuppressed).mock.calls[0];
    expect(options).toEqual({ maxAgeMs: 0 });
  });
});

describe("a release stops itself when the provider's outcomes go bad", () => {
  it("halts, records why, and tells staff", async () => {
    await seedList(20);
    const created = await createRelease({ subject: "Going badly", body: "hi", dailyLimit: 20 });
    const releaseId = created.body.releaseId;

    // Enough of the release has landed for its outcomes to mean something, and
    // they are bad. Written straight into the ledger because what is under test
    // is the verdict, not how long it takes to reach a thousand sends.
    await sql`
      INSERT INTO mailing_list_release_recipients (id, release_id, email, status, settled_at)
      SELECT gen_random_uuid(), ${releaseId}::uuid, 'reached' || g || '@example.com', 'sent', now()
      FROM generate_series(1, 600) AS g
    `;
    vi.mocked(fetchDeliveryOutcomes).mockResolvedValue({ sent: 600, bounced: 120, unsubscribed: 2 });

    await tick();

    const progress = await readRelease(releaseId);
    expect(progress.status).toBe("halted");
    expect(progress.haltedReason).toContain("bounced");

    const alerts = vi.mocked(sendEmail).mock.calls.filter(([p]) => p.tag === "mailing-list-release-halted");
    expect(alerts).toHaveLength(1);
    expect(alerts[0][0].to).toBe("kevin.lourd@gmail.com");
    expect(alerts[0][0].htmlBody).toContain("Going badly");

    // And it sends nothing further.
    const sentAfter = mailed().length;
    await tick();
    expect(mailed().length).toBe(sentAfter);
  });

  it("keeps going when the outcomes are fine", async () => {
    await seedList(20);
    const created = await createRelease({ subject: "Going fine", body: "hi", dailyLimit: 20 });

    await sql`
      INSERT INTO mailing_list_release_recipients (id, release_id, email, status, settled_at)
      SELECT gen_random_uuid(), ${created.body.releaseId}::uuid, 'reached' || g || '@example.com', 'sent', now()
      FROM generate_series(1, 600) AS g
    `;
    vi.mocked(fetchDeliveryOutcomes).mockResolvedValue({ sent: 600, bounced: 3, unsubscribed: 1 });

    await tick();

    expect((await readRelease(created.body.releaseId)).status).not.toBe("halted");
  });

  it("decides nothing when the provider cannot be asked, rather than calling the release healthy", async () => {
    await seedList(20);
    const created = await createRelease({ subject: "Unknowable", body: "hi", dailyLimit: 20 });

    await sql`
      INSERT INTO mailing_list_release_recipients (id, release_id, email, status, settled_at)
      SELECT gen_random_uuid(), ${created.body.releaseId}::uuid, 'reached' || g || '@example.com', 'sent', now()
      FROM generate_series(1, 600) AS g
    `;
    vi.mocked(fetchDeliveryOutcomes).mockRejectedValue(new Error("email-gateway is restarting"));

    await tick();

    const progress = await readRelease(created.body.releaseId);
    expect(progress.status).toBe("running");
    // The question is asked again next time rather than answered from nothing.
    const [row] = await sql`
      SELECT last_health_check_at FROM mailing_list_releases WHERE id = ${created.body.releaseId}
    `;
    expect(row.last_health_check_at).toBeNull();
  });
});

describe("the synchronous send stops being a trap", () => {
  it("behaves exactly as it always did for a list it can finish", async () => {
    await request(app)
      .post("/mailing-lists/investors/subscribers")
      .set(AUTH)
      .send({ raw: "one@example.com" })
      .expect(200);

    const res = await request(app)
      .post("/mailing-lists/investors/updates")
      .set(AUTH)
      .send({ subject: "Investor update", body: "# Q3" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.recipientCount).toBe(1);
    expect(mailed()).toEqual(["one@example.com"]);
  });

  it("refuses a list too large for it and names what to use instead", async () => {
    await seedList(LIST_SIZE);

    const res = await request(app)
      .post(`/mailing-lists/${SLUG}/updates`)
      .set(AUTH)
      .send({ subject: "Too big", body: "# Hello" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`POST /mailing-lists/${SLUG}/releases`);
    expect(res.body.error).toContain("dailyLimit");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("the tick route", () => {
  it("is reachable by a staff caller and reports what it did", async () => {
    await seedList(5);
    await createRelease({ subject: "Ticked", body: "hi", dailyLimit: 5 });

    const res = await request(app)
      .post("/internal/mailing-lists/releases/tick")
      .set({ "x-api-key": API_KEY })
      .expect(200);

    expect(res.body.releasesConsidered).toBe(1);
    // One tick takes a slice, not the release: the pace is the product.
    expect(res.body.sent).toBeGreaterThan(0);
    expect(res.body.sent).toBeLessThanOrEqual(MAX_TICK_BATCH);
    expect(res.body.skippedBusy).toBe(false);
  });

  it("refuses an unauthenticated caller", async () => {
    await request(app).post("/internal/mailing-lists/releases/tick").expect(401);
  });
});
