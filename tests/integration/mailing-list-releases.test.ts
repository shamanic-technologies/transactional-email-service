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

vi.mock("../../src/lib/email-verification.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  fetchVerdicts: vi.fn(),
}));

vi.mock("../../src/lib/run-outcomes.js", () => ({
  declareRunOutcomes: vi.fn(),
}));

// campaign-service is not running here: the campaign a release names is taken
// as held by its org, and a release naming none is refused by the real rule.
vi.mock("../../src/lib/release-campaign.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../../src/lib/release-campaign.js");
  return {
    ...actual,
    resolveReleaseCampaign: vi.fn(async (input: { campaignId?: string; brandIds?: string[] }) => {
      if (!input.campaignId) throw new actual.ReleaseCampaignRefusal("campaign_required", "A release must name the campaign it runs under");
      return { campaignId: input.campaignId, brandIds: input.brandIds?.length ? input.brandIds : ["brand_of_campaign"] };
    }),
  };
});

import app from "../../src/index.js";
import { db, sql } from "../../src/db/index.js";
import { sendEmail } from "../../src/lib/email-gateway.js";
import { createRun, updateRun } from "../../src/lib/runs-client.js";
import { declareRunOutcomes } from "../../src/lib/run-outcomes.js";
import { declareNewsletterUnits } from "../../src/lib/newsletter-units.js";
import { fetchSuppressed } from "../../src/lib/suppression.js";
import { fetchDeliveryOutcomes } from "../../src/lib/release-health.js";
import { fetchVerdicts, VerificationUnavailableError, type Verdict } from "../../src/lib/email-verification.js";
import { resetReleaseWorkerState, runReleaseTick } from "../../src/lib/release-worker.js";
import { seedStaffTemplates } from "../../src/templates/staff-alerts.js";
import { MAX_DAILY_LIMIT, MAX_TICK_BATCH } from "../../src/lib/release-pacing.js";

const API_KEY = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY!;
const AUTH = { "x-api-key": API_KEY, "x-org-id": "org_test", "x-user-id": "user_staff", "x-campaign-id": "campaign_newsletter" };

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

/** Verdicts for whatever the worker asks about: `valid` unless named otherwise. */
function verdicts(overrides: Record<string, Verdict["verdict"]> = {}) {
  return async (_release: unknown, emails: string[]) =>
    new Map<string, Verdict>(
      emails.map((email, i) => [
        email.toLowerCase(),
        { email: email.toLowerCase(), verdict: overrides[email] ?? "valid", verificationId: `ver-${email}-${i}` },
      ])
    );
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
    if (report.sent === 0 && report.failed === 0 && report.skippedOptedOut === 0 && report.skippedUndeliverable === 0) break;
  }
  return ticks;
}

async function setPace(releaseId: string, dailyLimit: number) {
  return request(app).patch(`/mailing-lists/releases/${releaseId}/pace`).set(AUTH).send({ dailyLimit });
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
  vi.mocked(fetchVerdicts).mockReset();
  vi.mocked(fetchVerdicts).mockImplementation(verdicts());
  vi.mocked(declareRunOutcomes).mockReset();
  vi.mocked(declareRunOutcomes).mockImplementation(async (_runId, _identity, body) => ({
    recordedCount: (body.produced?.length ?? 0) + (body.consumed?.length ?? 0),
    alreadyRecordedCount: 0,
  }));
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

describe("releases spread over the list instead of piling on its head", () => {
  async function reachedBy(releaseId: string): Promise<string[]> {
    const rows = await sql`
      SELECT email FROM mailing_list_release_recipients
      WHERE release_id = ${releaseId} AND status = 'sent'
    `;
    return rows.map((r) => r.email as string);
  }

  it("two releases running in parallel reach disjoint people in a day", async () => {
    await seedList(100);
    const a = await createRelease({ subject: "Issue A", body: "a", dailyLimit: 30 });
    const b = await createRelease({ subject: "Issue B", body: "b", dailyLimit: 30 });

    await drain();

    const reachedA = await reachedBy(a.body.releaseId);
    const reachedB = await reachedBy(b.body.releaseId);
    expect(reachedA.length).toBe(30);
    expect(reachedB.length).toBe(30);
    expect(reachedA.filter((email) => reachedB.includes(email))).toEqual([]);
    // Nobody twice within a release.
    expect(new Set(reachedA).size).toBe(30);
    expect(new Set(reachedB).size).toBe(30);
  });

  it("a later release goes to people no earlier release reached, then to the least recently mailed", async () => {
    await seedList(40);
    const first = await createRelease({ subject: "Older issue", body: "1", dailyLimit: 15 });
    await drain();
    const reachedFirst = await reachedBy(first.body.releaseId);
    expect(reachedFirst.length).toBe(15);

    const second = await createRelease({ subject: "Newer issue", body: "2", dailyLimit: 30 });
    await drain();
    const reachedSecond = await reachedBy(second.body.releaseId);
    expect(reachedSecond.length).toBe(30);

    // The 25 nobody had mailed come first; only then 5 of the first release's 15.
    const repeats = reachedSecond.filter((email) => reachedFirst.includes(email));
    expect(repeats.length).toBe(5);
    expect(new Set(addresses(40).filter((e) => !reachedFirst.includes(e)))).toEqual(
      new Set(reachedSecond.filter((e) => !reachedFirst.includes(e)))
    );
  });

  it("among people mailed equally often, the least recently mailed go first", async () => {
    await seedList(4);
    const older = await createRelease({ subject: "Old", body: "o", dailyLimit: 4 });
    await drain();
    // Make two of them recently mailed.
    const recent = addresses(4).slice(0, 2);
    await sql`
      UPDATE mailing_list_release_recipients SET settled_at = now()
      WHERE release_id = ${older.body.releaseId} AND email IN ${sql(recent)}
    `;
    await sql`
      UPDATE mailing_list_release_recipients SET settled_at = now() - interval '10 days'
      WHERE release_id = ${older.body.releaseId} AND email NOT IN ${sql(recent)}
    `;

    const next = await createRelease({ subject: "Next", body: "n", dailyLimit: 2 });
    await drain();
    const reached = await reachedBy(next.body.releaseId);
    expect(new Set(reached)).toEqual(new Set(addresses(4).slice(2)));
  });
});

describe("every release send names the subscriber it reaches, for the cost ledger", () => {
  async function subscriberIds(): Promise<Map<string, string>> {
    const rows = await sql`
      SELECT s.email, s.id FROM mailing_list_subscribers s
      JOIN mailing_lists l ON l.id = s.list_id WHERE l.slug = ${SLUG}
    `;
    return new Map(rows.map((r) => [r.email as string, r.id as string]));
  }

  it("carries outcomeSubject = the subscriber row and consumes email_checked", async () => {
    await seedList(3);
    await createRelease({ subject: "Ledger", body: "hi", dailyLimit: 10 });
    await drain();

    const ids = await subscriberIds();
    const calls = vi.mocked(sendEmail).mock.calls.map(([p]) => p);
    expect(calls).toHaveLength(3);
    for (const p of calls) {
      expect(p.outcomeSubject).toEqual({ subjectService: "transactional-email-service", subjectId: ids.get(p.to) });
      expect(p.consumedOutcomeKeys).toEqual(["email_checked"]);
    }
    // The verification before the send names the SAME subject, so the
    // email_checked apollo-service produces is the one the send consumed.
    const [, emails, subjects] = vi.mocked(fetchVerdicts).mock.calls[0];
    for (const email of emails) {
      expect(subjects!.get(email)).toEqual({ subjectService: "transactional-email-service", subjectId: ids.get(email) });
    }
  });

  it("names the same subject for one subscriber across two releases", async () => {
    await seedList(2);
    await createRelease({ subject: "One", body: "1", dailyLimit: 10 });
    await createRelease({ subject: "Two", body: "2", dailyLimit: 10 });
    await drain();

    const target = addresses(2)[0];
    const subjects = vi
      .mocked(sendEmail)
      .mock.calls.map(([p]) => p)
      .filter((p) => p.to === target)
      .map((p) => p.outcomeSubject);
    expect(subjects).toHaveLength(2);
    expect(subjects[0]).toEqual(subjects[1]);
    expect(subjects[0]?.subjectId).toBe((await subscriberIds()).get(target));
  });

  it("still sends, naming nobody, to an address removed from the list after the release froze it", async () => {
    await seedList(2);
    await createRelease({ subject: "Frozen", body: "hi", dailyLimit: 10 });
    const removed = addresses(2)[1];
    await sql`DELETE FROM mailing_list_subscribers WHERE email = ${removed}`;
    await drain();

    const p = vi.mocked(sendEmail).mock.calls.map(([c]) => c).find((c) => c.to === removed)!;
    expect(p).toBeDefined();
    expect(p.outcomeSubject).toBeUndefined();
    expect(p.consumedOutcomeKeys).toBeUndefined();
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

describe("every address is verified before its slice is sent", () => {
  it("sends only `valid`, settles every other verdict as skipped_undeliverable with the verdict stored, and counts them on the release", async () => {
    await seedList(20);
    const all = addresses(20);
    const overrides: Record<string, Verdict["verdict"]> = {
      [all[1]]: "catch_all",
      [all[2]]: "unknown",
      [all[3]]: "risky",
      [all[4]]: "invalid",
    };
    vi.mocked(fetchVerdicts).mockImplementation(verdicts(overrides));
    const created = await createRelease({ subject: "Verified", body: "hi", dailyLimit: 20 });

    await drain();

    const skipped = Object.keys(overrides);
    for (const email of skipped) expect(mailed()).not.toContain(email);
    expect(mailed().sort()).toEqual(all.filter((e) => !skipped.includes(e)).sort());

    const rows = await sql`
      SELECT email, status, verdict, verification_id, reason FROM mailing_list_release_recipients
      WHERE release_id = ${created.body.releaseId} ORDER BY email
    `;
    for (const row of rows) {
      expect(row.verification_id).toBeTruthy();
      if (skipped.includes(row.email)) {
        expect(row.status).toBe("skipped_undeliverable");
        expect(row.verdict).toBe(overrides[row.email]);
        expect(row.reason).toContain(overrides[row.email]);
      } else {
        expect(row.status).toBe("sent");
        expect(row.verdict).toBe("valid");
      }
    }

    const release = await readRelease(created.body.releaseId);
    expect(release.skippedUndeliverable).toBe(4);
    expect(release.reached).toBe(16);
    expect(release.status).toBe("completed");
  });

  it("asks only about addresses the provider is not suppressing, under the release's own identity", async () => {
    await seedList(3);
    const all = addresses(3);
    vi.mocked(fetchSuppressed).mockResolvedValue(suppressing(all[0]));
    const created = await createRelease({ subject: "Order", body: "hi", dailyLimit: 3 });

    await drain();

    const asked = vi.mocked(fetchVerdicts).mock.calls.flatMap(([, emails]) => emails);
    expect(asked).not.toContain(all[0]);
    expect(asked.sort()).toEqual([all[1], all[2]]);
    const [release] = vi.mocked(fetchVerdicts).mock.calls[0];
    expect(release).toMatchObject({ id: created.body.releaseId, orgId: "org_test", userId: "user_staff" });
  });

  it("sends NOTHING from a slice whose verdicts cannot be had, returns it to pending, and sends it once they can", async () => {
    await seedList(5);
    const created = await createRelease({ subject: "Loud", body: "hi", dailyLimit: 5 });
    vi.mocked(fetchVerdicts).mockRejectedValue(new VerificationUnavailableError("apollo-service POST /email-verifications 502"));

    const report = await tick();

    expect(sendEmail).not.toHaveBeenCalled();
    expect(report.sent).toBe(0);
    expect(report.verificationUnavailable).toBe(1);
    const rows = await sql`
      SELECT status, verdict, claimed_at FROM mailing_list_release_recipients WHERE release_id = ${created.body.releaseId}
    `;
    expect(rows.every((r: any) => r.status === "pending" && r.verdict === null && r.claimed_at === null)).toBe(true);
    expect((await readRelease(created.body.releaseId)).status).toBe("running");

    vi.mocked(fetchVerdicts).mockImplementation(verdicts());
    await drain();
    expect(mailed().sort()).toEqual(addresses(5));
  });

  describe("a release that keeps failing to verify", () => {
    // A fixed morning, so the day's allowance never runs out under the test and
    // every tick has a slice to verify. One tick a minute, as in production.
    const START = Date.parse("2026-10-01T08:00:00Z");
    const at = (minute: number) => new Date(START + minute * 60_000);
    const BALANCE_502 =
      'apollo-service POST /email-verifications 502: {"error":"billing-service: insufficient balance for org"}';

    function stallAlerts() {
      return vi.mocked(sendEmail).mock.calls.filter(([p]) => p.tag === "mailing-list-release-stalled");
    }

    it("tells staff exactly once, with the upstream reason, after half an hour of nothing sent", async () => {
      await seedList(50);
      const created = await createRelease({ subject: "Stuck newsletter", body: "hi", dailyLimit: 1000 });
      vi.mocked(fetchVerdicts).mockRejectedValue(new VerificationUnavailableError(BALANCE_502));

      // 29 minutes of failing ticks: not yet.
      for (let minute = 0; minute < 30; minute++) await runReleaseTick(at(minute));
      expect(stallAlerts()).toHaveLength(0);

      // The 31st consecutive failure, 30 minutes after the first: now.
      await runReleaseTick(at(30));
      expect(stallAlerts()).toHaveLength(1);

      // And never again for the same stall, however long it lasts.
      for (let minute = 31; minute < 180; minute++) await runReleaseTick(at(minute));
      expect(stallAlerts()).toHaveLength(1);

      const [[alert]] = stallAlerts();
      expect(alert.to).toBe("kevin.lourd@gmail.com");
      expect(alert.subject).toContain("Stuck newsletter");
      expect(alert.htmlBody).toContain("insufficient balance");
      expect(alert.textBody).toContain("insufficient balance");
      expect(alert.textBody).toContain("2026-10-01T08:00:00.000Z");
      expect(alert.textBody).toContain("0 of 50, 50 waiting");
      expect(alert.textBody).not.toContain("{{");
      expect(sendEmail).toHaveBeenCalledTimes(1);

      const [row] = await sql`
        SELECT stall_ticks, stall_reason, stall_alerted_at FROM mailing_list_releases WHERE id = ${created.body.releaseId}
      `;
      expect(row.stall_ticks).toBe(180);
      expect(row.stall_reason).toContain("insufficient balance");
      expect(row.stall_alerted_at).not.toBeNull();
    });

    it("raises nothing for a single transient 502, and a recovery starts the clock over", async () => {
      await seedList(200);
      const created = await createRelease({ subject: "Blip", body: "hi", dailyLimit: 5000 });

      // Fails for 20 minutes, recovers, fails again for 20: never 30 in a row.
      vi.mocked(fetchVerdicts).mockRejectedValue(new VerificationUnavailableError(BALANCE_502));
      for (let minute = 0; minute < 20; minute++) await runReleaseTick(at(minute));
      vi.mocked(fetchVerdicts).mockImplementation(verdicts());
      await runReleaseTick(at(20));
      const [cleared] = await sql`
        SELECT stall_ticks, stalled_since FROM mailing_list_releases WHERE id = ${created.body.releaseId}
      `;
      expect(cleared.stall_ticks).toBe(0);
      expect(cleared.stalled_since).toBeNull();

      vi.mocked(fetchVerdicts).mockRejectedValue(new VerificationUnavailableError(BALANCE_502));
      for (let minute = 21; minute < 41; minute++) await runReleaseTick(at(minute));

      expect(stallAlerts()).toHaveLength(0);
    });

    it("raises nothing on normal ticks", async () => {
      await seedList(50);
      await createRelease({ subject: "Normal", body: "hi", dailyLimit: 1000 });

      for (let minute = 0; minute < 60; minute++) await runReleaseTick(at(minute));

      expect(stallAlerts()).toHaveLength(0);
      expect(mailed()).toHaveLength(50);
    });

    it("alerts again for a NEW stall after a recovery", async () => {
      await seedList(200);
      await createRelease({ subject: "Twice", body: "hi", dailyLimit: 5000 });

      vi.mocked(fetchVerdicts).mockRejectedValue(new VerificationUnavailableError(BALANCE_502));
      for (let minute = 0; minute <= 30; minute++) await runReleaseTick(at(minute));
      expect(stallAlerts()).toHaveLength(1);

      vi.mocked(fetchVerdicts).mockImplementation(verdicts());
      await runReleaseTick(at(31));

      vi.mocked(fetchVerdicts).mockRejectedValue(new VerificationUnavailableError(BALANCE_502));
      for (let minute = 32; minute <= 62; minute++) await runReleaseTick(at(minute));
      expect(stallAlerts()).toHaveLength(2);
    });

    it("retries the alert on the next tick when sending it failed", async () => {
      await seedList(50);
      await createRelease({ subject: "Alert lost", body: "hi", dailyLimit: 1000 });
      vi.mocked(fetchVerdicts).mockRejectedValue(new VerificationUnavailableError(BALANCE_502));
      vi.mocked(sendEmail).mockRejectedValueOnce(new Error("email-gateway 503"));

      for (let minute = 0; minute <= 31; minute++) await runReleaseTick(at(minute));

      // First attempt (minute 30) threw, second (minute 31) went out; nothing after.
      expect(stallAlerts()).toHaveLength(2);
      for (let minute = 32; minute < 40; minute++) await runReleaseTick(at(minute));
      expect(stallAlerts()).toHaveLength(2);
    });
  });

  it("does not spend the day's allowance on a skipped address", async () => {
    await seedList(10);
    const all = addresses(10);
    vi.mocked(fetchVerdicts).mockImplementation(verdicts({ [all[0]]: "catch_all", [all[1]]: "catch_all", [all[2]]: "invalid" }));
    const created = await createRelease({ subject: "Allowance", body: "hi", dailyLimit: 5 });

    await drain();

    expect(mailed()).toHaveLength(5);
    const release = await readRelease(created.body.releaseId);
    expect(release.todayUsed).toBe(5);
    expect(release.skippedUndeliverable).toBe(3);
    expect(release.remaining).toBe(2);
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

  it("asks the provider about this release under the run its messages are sent with", async () => {
    // The handle is the release's own run, which every send carries as
    // x-run-id and the provider persists as each message's parent run. Not the
    // release id, and not the send tag: a tag is per-template in storage, so a
    // tag-keyed aggregate answers for every release that used the same one.
    await seedList(20);
    const created = await createRelease({ subject: "By run", body: "hi", dailyLimit: 20 });

    await sql`
      INSERT INTO mailing_list_release_recipients (id, release_id, email, status, settled_at)
      SELECT gen_random_uuid(), ${created.body.releaseId}::uuid, 'reached' || g || '@example.com', 'sent', now()
      FROM generate_series(1, 600) AS g
    `;
    vi.mocked(fetchDeliveryOutcomes).mockResolvedValue({ sent: 600, bounced: 1, unsubscribed: 1 });

    await tick();

    const [row] = await sql`SELECT run_id FROM mailing_list_releases WHERE id = ${created.body.releaseId}`;
    expect(vi.mocked(fetchDeliveryOutcomes)).toHaveBeenCalledWith(row.run_id);
    expect(vi.mocked(fetchDeliveryOutcomes)).not.toHaveBeenCalledWith(created.body.releaseId);
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

  it("refuses to read a release it cannot see as a healthy one", async () => {
    // The gateway answers that no message is recorded under this release's run.
    // The ledger says hundreds were reached, so both cannot be true: this is a
    // release whose outcomes are not visible, not a healthy release. It must
    // not stamp a health check and must not be treated as assessed.
    //
    // Under v0.22.x this case arrived as a well-formed { sent: 0 }, because the
    // only per-operation filter available then was the CHILD run the provider
    // mints per send — so the question matched nothing and answered zero. The
    // probe now reports an empty match as an empty match, which is why it
    // surfaces here as a refusal rather than as a number.
    await seedList(20);
    const created = await createRelease({ subject: "Invisible", body: "hi", dailyLimit: 20 });

    await sql`
      INSERT INTO mailing_list_release_recipients (id, release_id, email, status, settled_at)
      SELECT gen_random_uuid(), ${created.body.releaseId}::uuid, 'reached' || g || '@example.com', 'sent', now()
      FROM generate_series(1, 600) AS g
    `;
    vi.mocked(fetchDeliveryOutcomes).mockRejectedValue(
      new Error("email-gateway reports no message under run 11111111-2222-4333-8444-000000000001 — the question found nothing, which is not a verdict")
    );

    await tick();

    expect((await readRelease(created.body.releaseId)).status).toBe("running");
    const [row] = await sql`
      SELECT last_health_check_at FROM mailing_list_releases WHERE id = ${created.body.releaseId}
    `;
    expect(row.last_health_check_at).toBeNull();
  });

  it("tags every message with the release, so its mail is findable on its own in the provider's archive", async () => {
    await seedList(5);
    const created = await createRelease({ subject: "Tagged", body: "hi", dailyLimit: 5 });

    await tick();

    const tags = vi.mocked(sendEmail).mock.calls.map(([p]) => p.tag);
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags)).toEqual(new Set([`mailing-list-release-${created.body.releaseId}`]));
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

describe("changing the pace while a release is running", () => {
  it("lets more go out the same day when the pace is raised, and repeats nobody", async () => {
    await seedList(LIST_SIZE);
    const created = await createRelease({ subject: "Cautious start", body: "hi", dailyLimit: 20 });
    const releaseId = created.body.releaseId;

    await drain();
    const cautious = mailed().length;
    expect(cautious).toBe(20);
    expect((await readRelease(releaseId)).nextSliceSize).toBe(0);

    // Day one came back clean. Go faster, without waiting for tomorrow.
    const repaced = await setPace(releaseId, 200);
    expect(repaced.status).toBe(200);
    expect(repaced.body.dailyLimit).toBe(200);

    await drain();
    expect(mailed().length).toBeGreaterThan(cautious);
    expect(mailed().length).toBe(200);
    // The raise is an allowance, not a licence: the new pace still bounds the day.
    expect(new Set(mailed()).size).toBe(mailed().length);
  });

  it("reports the new pace and a revised estimate of how long it has left", async () => {
    await seedList(LIST_SIZE);
    const created = await createRelease({ subject: "Estimate", body: "hi", dailyLimit: 100 });
    const releaseId = created.body.releaseId;

    expect((await readRelease(releaseId)).estimatedDaysRemaining).toBe(3);

    await setPace(releaseId, LIST_SIZE).then((r) => expect(r.status).toBe(200));

    const after = await readRelease(releaseId);
    expect(after.dailyLimit).toBe(LIST_SIZE);
    expect(after.estimatedDaysRemaining).toBe(1);
  });

  it("claws nothing back when the pace is lowered below what the day already sent: the day rests", async () => {
    await seedList(LIST_SIZE);
    const created = await createRelease({ subject: "Too fast", body: "hi", dailyLimit: 100 });
    const releaseId = created.body.releaseId;

    await drain();
    expect(mailed().length).toBe(100);

    const repaced = await setPace(releaseId, 10);
    expect(repaced.status).toBe(200);
    expect(repaced.body.dailyLimit).toBe(10);
    expect(repaced.body.reached).toBe(100);
    expect(repaced.body.todayUsed).toBe(100);
    expect(repaced.body.nextSliceSize).toBe(0);
    // 150 still waiting, today spent: fifteen days from tomorrow.
    expect(repaced.body.estimatedDaysRemaining).toBe(15);

    await drain();
    expect(mailed().length).toBe(100);

    const [sent] = await sql`
      SELECT count(*)::int AS n FROM mailing_list_release_recipients
      WHERE release_id = ${releaseId} AND status = 'sent'
    `;
    expect(sent.n).toBe(100);
  });

  it("repeats nobody and drops nobody across several pace changes", async () => {
    await seedList(LIST_SIZE);
    const created = await createRelease({ subject: "Repaced twice", body: "hi", dailyLimit: 20 });
    const releaseId = created.body.releaseId;

    await drain();
    await setPace(releaseId, 60).then((r) => expect(r.status).toBe(200));
    await drain();
    await setPace(releaseId, LIST_SIZE).then((r) => expect(r.status).toBe(200));
    await drain();

    const everybody = addresses().sort();
    expect([...mailed()].sort()).toEqual(everybody);
    expect(new Set(mailed()).size).toBe(LIST_SIZE);

    const progress = await readRelease(releaseId);
    expect(progress.status).toBe("completed");
    expect(progress.reached).toBe(LIST_SIZE);
    expect(progress.remaining).toBe(0);
    expect(progress.estimatedDaysRemaining).toBe(0);

    const [pending] = await sql`
      SELECT count(*)::int AS n FROM mailing_list_release_recipients
      WHERE release_id = ${releaseId} AND status = 'pending'
    `;
    expect(pending.n).toBe(0);
  });

  it("takes a new pace while paused, and it governs when the release resumes", async () => {
    await seedList(LIST_SIZE);
    const created = await createRelease({ subject: "Paused repace", body: "hi", dailyLimit: 20 });
    const releaseId = created.body.releaseId;

    await request(app).post(`/mailing-lists/releases/${releaseId}/pause`).set(AUTH).expect(200);
    expect((await setPace(releaseId, 150)).status).toBe(200);

    await request(app).post(`/mailing-lists/releases/${releaseId}/resume`).set(AUTH).expect(200);
    await drain();

    expect(mailed().length).toBe(150);
    expect(new Set(mailed()).size).toBe(150);
  });

  it("refuses a pace the worker cannot deliver, exactly as creating one does", async () => {
    await seedList(5);
    const created = await createRelease({ subject: "x", body: "y", dailyLimit: 5 });

    const tooFast = await setPace(created.body.releaseId, MAX_DAILY_LIMIT + 1);
    expect(tooFast.status).toBe(400);
    expect((await setPace(created.body.releaseId, 0)).status).toBe(400);

    // Refused, not partly applied.
    expect((await readRelease(created.body.releaseId)).dailyLimit).toBe(5);
  });

  it("refuses a cancelled release, and says it never resumes", async () => {
    await seedList(5);
    const created = await createRelease({ subject: "x", body: "y", dailyLimit: 5 });
    await request(app).post(`/mailing-lists/releases/${created.body.releaseId}/cancel`).set(AUTH).expect(200);

    const res = await setPace(created.body.releaseId, 3);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("never resumes");
  });

  it("refuses a completed release, and says there is nobody left to pace", async () => {
    await seedList(5);
    const created = await createRelease({ subject: "x", body: "y", dailyLimit: 5 });
    await drain();
    expect((await readRelease(created.body.releaseId)).status).toBe("completed");

    const res = await setPace(created.body.releaseId, 3);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("nobody left");
  });

  it("refuses a release that stopped itself on the provider's outcomes", async () => {
    await seedList(20);
    const created = await createRelease({ subject: "Going badly", body: "hi", dailyLimit: 20 });
    const releaseId = created.body.releaseId;

    await sql`
      INSERT INTO mailing_list_release_recipients (id, release_id, email, status, settled_at)
      SELECT gen_random_uuid(), ${releaseId}::uuid, 'reached' || g || '@example.com', 'sent', now()
      FROM generate_series(1, 600) AS g
    `;
    vi.mocked(fetchDeliveryOutcomes).mockResolvedValue({ sent: 600, bounced: 120, unsubscribed: 2 });
    await tick();
    expect((await readRelease(releaseId)).status).toBe("halted");

    const res = await setPace(releaseId, 1);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("delivery outcomes");
  });

  it("answers 404 for a release that does not exist, and 401 without a key", async () => {
    const missing = await setPace("11111111-2222-4333-8444-999999999999", 5);
    expect(missing.status).toBe(404);

    await request(app)
      .patch("/mailing-lists/releases/11111111-2222-4333-8444-999999999999/pace")
      .send({ dailyLimit: 5 })
      .expect(401);
  });
});

describe("who clicked (NEWSLETTER-WHO-CLICKED-1024)", () => {
  const BODY =
    "Read [the study](https://distribute.you/blog/jev-gtm?utm_source=newsletter&utm_medium=email&utm_campaign=jev-gtm) " +
    "or [the source](https://example.com/paper?utm_source=newsletter).";

  function linkIdIn(html: string): string | null {
    const m = html.match(/href="https:\/\/distribute\.you\/blog\/jev-gtm\?[^"]*dy_sub=([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  it("stamps each subscriber's own id on every distribute.you link, none on a third-party one, and resolves it", async () => {
    await seedList(2);
    await createRelease({ subject: "jev-gtm", body: BODY, dailyLimit: 100 });
    await drain();

    const calls = vi.mocked(sendEmail).mock.calls.map(([p]) => p);
    expect(calls).toHaveLength(2);

    const ids = calls.map((c) => linkIdIn(c.htmlBody));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    for (const c of calls) {
      expect(c.htmlBody).toContain('href="https://example.com/paper?utm_source=newsletter"');
      expect(c.htmlBody).not.toContain(c.to);
      expect(c.textBody).toContain(`dy_sub=${linkIdIn(c.htmlBody)}`);
    }

    for (const c of calls) {
      const res = await request(app).get(`/internal/subscriber-links/${linkIdIn(c.htmlBody)}`).set({ "x-api-key": API_KEY });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("valid");
      expect(res.body.subscriber.email).toBe(c.to);
      expect(res.body.subscriber.name).toBeNull();
      expect(res.body.list.slug).toBe(SLUG);
    }
  });

  it("reuses the same id on a later release", async () => {
    await seedList(1);
    await createRelease({ subject: "one", body: BODY, dailyLimit: 100 });
    await drain();
    await createRelease({ subject: "two", body: BODY + " again", dailyLimit: 100 });
    await drain();

    const ids = vi.mocked(sendEmail).mock.calls.map(([p]) => linkIdIn(p.htmlBody));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("answers tampered, unknown and revoked distinctly, and refuses a caller without the key", async () => {
    await seedList(1);
    await createRelease({ subject: "jev-gtm", body: BODY, dailyLimit: 100 });
    await drain();
    const [[sent]] = vi.mocked(sendEmail).mock.calls;
    const id = linkIdIn(sent.htmlBody)!;
    const get = (linkId: string) => request(app).get(`/internal/subscriber-links/${encodeURIComponent(linkId)}`).set({ "x-api-key": API_KEY });

    expect((await request(app).get(`/internal/subscriber-links/${id}`)).status).toBe(401);

    const forged = (id[0] === "A" ? "B" : "A") + id.slice(1);
    const tampered = await get(forged);
    expect(tampered.status).toBe(400);
    expect(tampered.body).toEqual({ status: "tampered", linkId: forged });

    const { mintLinkId } = await import("../../src/lib/subscriber-link.js");
    const unknown = await get(mintLinkId());
    expect(unknown.status).toBe(404);
    expect(unknown.body.status).toBe("unknown");

    await request(app)
      .delete(`/mailing-lists/${SLUG}/subscribers`)
      .query({ email: sent.to })
      .set(AUTH)
      .expect(200);
    const revoked = await get(id);
    expect(revoked.status).toBe(410);
    expect(revoked.body).toEqual({ status: "revoked", linkId: id });
  });
});

describe("every newsletter email is one newsletter_email_sent Unit on the release's org (OUTCOME-FINEST-1106)", () => {
  const BODY = "Read [the study](https://distribute.you/blog/jev-gtm?utm_source=newsletter) or [the source](https://example.com/paper).";

  async function subscriberIds(): Promise<Map<string, string>> {
    const rows = await sql<Array<{ id: string; email: string }>>`SELECT id::text AS id, email FROM mailing_list_subscribers`;
    return new Map(rows.map((r) => [r.email, r.id]));
  }

  async function recipientRows(releaseId: string) {
    return sql<Array<{ id: string; email: string; unit_declared_at: Date | null }>>`
      SELECT id::text AS id, email, unit_declared_at FROM mailing_list_release_recipients WHERE release_id = ${releaseId}::uuid AND status = 'sent'`;
  }

  it("declares one Unit per subscriber reached, on a spend-free child run of the release's run, on the release's org", async () => {
    await seedList(6);
    const created = await createRelease({ subject: "units", body: BODY, dailyLimit: 100 });
    expect(created.status).toBe(201);
    const releaseRunId = vi.mocked(createRun).mock.results[0].value;
    await drain();
    expect(mailed()).toHaveLength(6);

    const report = await declareNewsletterUnits();
    expect(report).toMatchObject({ units: 6, declared: 6, unitsRunsOpened: 1, error: null });

    // The Units run: the release's org and acting user, a child of the release's run.
    const unitsRunCall = vi.mocked(createRun).mock.calls.find(([p]) => p.taskName === "newsletter-email-units")!;
    expect(unitsRunCall[0]).toMatchObject({
      orgId: "org_test",
      userId: "user_staff",
      serviceName: "transactional-email-service",
      parentRunId: (await releaseRunId).id,
    });
    const unitsRunId = (await vi.mocked(createRun).mock.results[vi.mocked(createRun).mock.calls.indexOf(unitsRunCall)].value).id;
    expect(vi.mocked(updateRun)).toHaveBeenCalledWith(unitsRunId, "completed", { orgId: "org_test", userId: "user_staff" }, expect.anything());

    const calls = vi.mocked(declareRunOutcomes).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [runId, identity] of calls) {
      expect(runId).toBe(unitsRunId);
      expect(identity).toEqual({ orgId: "org_test", userId: "user_staff" });
    }

    const rows = await recipientRows(created.body.releaseId);
    const subs = await subscriberIds();
    const produced = calls.flatMap(([, , body]) => body.produced ?? []);
    const consumed = calls.flatMap(([, , body]) => body.consumed ?? []);
    expect(produced).toHaveLength(6);
    expect(produced.map((p) => p.outcomeKey)).toEqual(Array(6).fill("newsletter_email_sent"));
    expect(new Set(produced.map((p) => p.subjectService))).toEqual(new Set(["transactional-email-service"]));
    expect(produced.map((p) => p.subjectId).sort()).toEqual(rows.map((r) => r.id).sort());
    // Each Unit is made of its send: the subscriber's message_sent.
    expect(consumed.map((c) => c.outcomeKey)).toEqual(Array(6).fill("message_sent"));
    expect(consumed.map((c) => c.subjectId).sort()).toEqual(rows.map((r) => subs.get(r.email)!).sort());
    for (const [, , body] of calls) expect(Number.isNaN(Date.parse(body.occurredAt!))).toBe(false);

    expect(rows.every((r) => r.unit_declared_at !== null)).toBe(true);

    // Each email's links name its own Unit.
    for (const [p] of vi.mocked(sendEmail).mock.calls) {
      const row = rows.find((r) => r.email === p.to)!;
      expect(p.htmlBody).toContain(`dy_unit=newsletter_email_sent:transactional-email-service:${row.id}`);
      expect(p.textBody).toContain(`dy_unit=newsletter_email_sent:transactional-email-service:${row.id}`);
      expect(p.htmlBody).toContain('href="https://example.com/paper"');
    }

    // A second pass finds nothing left; a later release opens its own Units run.
    expect(await declareNewsletterUnits()).toMatchObject({ units: 0, declared: 0 });
    const res = await request(app).get("/internal/mailing-list-releases").set({ "x-api-key": API_KEY }).expect(200);
    expect(res.body.outcomeKey).toBe("newsletter_email_sent");
    expect(res.body.releases[0]).toMatchObject({
      releaseId: created.body.releaseId,
      orgId: "org_test",
      runId: (await releaseRunId).id,
      unitsRunId,
      emailsSent: 6,
      unitsDeclared: 6,
    });
  });

  it("keeps the rows undeclared when runs-service refuses, and declares them on the next pass", async () => {
    await seedList(3);
    const created = await createRelease({ subject: "units-retry", body: BODY, dailyLimit: 100 });
    await drain();

    vi.mocked(declareRunOutcomes).mockRejectedValueOnce(new Error("runs-service POST failed: 400 - unknown_outcome_key"));
    const failed = await declareNewsletterUnits();
    expect(failed.error).toContain("unknown_outcome_key");
    expect(failed.declared).toBe(0);
    expect((await recipientRows(created.body.releaseId)).every((r) => r.unit_declared_at === null)).toBe(true);

    const retried = await declareNewsletterUnits();
    expect(retried).toMatchObject({ declared: 3, unitsRunsOpened: 0, error: null });
    expect((await recipientRows(created.body.releaseId)).every((r) => r.unit_declared_at !== null)).toBe(true);
    // One Units run for the release, reused by the retry.
    expect(vi.mocked(createRun).mock.calls.filter(([p]) => p.taskName === "newsletter-email-units")).toHaveLength(1);
  });

  it("refuses the release list without the API key", async () => {
    await request(app).get("/internal/mailing-list-releases").expect(401);
    await request(app).post("/internal/newsletter-units/declare").expect(401);
  });
});

describe("a newsletter is drafted, then validated, then sent: three outcomes (NEWSLETTER-OUTCOMES-1107)", () => {
  const DRAFT = { subject: "Issue 12", body: "Read [the study](https://distribute.you/blog/x)." };
  const DRAFTED_AT = "2026-11-07T04:07:00.000Z";

  async function registerDraft(body: Record<string, unknown> = DRAFT, slug = SLUG) {
    return request(app).post(`/mailing-lists/${slug}/drafts`).set({ ...AUTH, "x-brand-id": "brand_dy" }).send(body);
  }

  function runOf(task: string) {
    const i = vi.mocked(createRun).mock.calls.findIndex(([p]) => p.taskName === task);
    return i < 0 ? null : { params: vi.mocked(createRun).mock.calls[i][0], result: vi.mocked(createRun).mock.results[i].value as Promise<{ id: string }> };
  }

  it("registers a draft as one newsletter_drafted Unit on a spend-free run, once", async () => {
    await seedList(3);
    const res = await registerDraft({ ...DRAFT, draftedAt: DRAFTED_AT });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true, slug: SLUG, subject: "Issue 12", draftedAt: DRAFTED_AT, draftedDeclared: true, validatedAt: null });
    expect(sendEmail).not.toHaveBeenCalled();

    const drafted = runOf("newsletter-drafted")!;
    expect(drafted.params).toMatchObject({ orgId: "org_test", userId: "user_staff", serviceName: "transactional-email-service", brandIds: ["brand_dy"] });
    const draftedRunId = (await drafted.result).id;
    expect(res.body.draftedRunId).toBe(draftedRunId);
    expect(vi.mocked(updateRun)).toHaveBeenCalledWith(draftedRunId, "completed", { orgId: "org_test", userId: "user_staff" }, expect.anything());
    expect(vi.mocked(declareRunOutcomes).mock.calls).toEqual([
      [
        draftedRunId,
        { orgId: "org_test", userId: "user_staff" },
        {
          produced: [{ outcomeKey: "newsletter_drafted", subjectService: "transactional-email-service", subjectId: res.body.draftId }],
          occurredAt: DRAFTED_AT,
        },
      ],
    ]);

    const again = await registerDraft();
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, draftId: res.body.draftId });
    expect(vi.mocked(createRun).mock.calls.filter(([p]) => p.taskName === "newsletter-drafted")).toHaveLength(1);
    expect(vi.mocked(declareRunOutcomes)).toHaveBeenCalledTimes(1);

    const read = await request(app).get(`/mailing-lists/drafts/${res.body.draftId}`).set(AUTH).expect(200);
    expect(read.body).toMatchObject({ draftId: res.body.draftId, draftedDeclared: true, validatedDeclared: false });
  });

  it("keeps a draft undeclared when runs-service refuses, and the same call declares it", async () => {
    await seedList(1);
    vi.mocked(declareRunOutcomes).mockRejectedValueOnce(new Error("runs-service POST failed: 400 - unknown_outcome_key"));
    const failed = await registerDraft();
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain("unknown_outcome_key");

    const retried = await registerDraft();
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ created: false, draftedDeclared: true });
    expect(vi.mocked(createRun).mock.calls.filter(([p]) => p.taskName === "newsletter-drafted")).toHaveLength(1);
  });

  it("a release naming the draft is its validation, and each email consumes it", async () => {
    await seedList(4);
    const draft = (await registerDraft()).body;
    vi.mocked(declareRunOutcomes).mockClear();

    const created = await createRelease({ ...DRAFT, dailyLimit: 100, draftId: draft.draftId });
    expect(created.status).toBe(201);
    expect(created.body.draftId).toBe(draft.draftId);

    const validated = runOf("newsletter-validated")!;
    expect(validated.params).toMatchObject({ orgId: "org_test", userId: "user_staff" });
    // Never a child of the drafted run: it holds a back-dated fact, runs-service gives it no child (run_holds_dated_facts).
    expect(validated.params.parentRunId).not.toBe(draft.draftedRunId);
    const validatedRunId = (await validated.result).id;
    expect(vi.mocked(declareRunOutcomes).mock.calls).toEqual([
      [
        validatedRunId,
        { orgId: "org_test", userId: "user_staff" },
        {
          produced: [{ outcomeKey: "newsletter_validated", subjectService: "transactional-email-service", subjectId: draft.draftId }],
          consumed: [{ outcomeKey: "newsletter_drafted", subjectService: "transactional-email-service", subjectId: draft.draftId }],
          occurredAt: expect.any(String),
        },
      ],
    ]);
    const read = await request(app).get(`/mailing-lists/drafts/${draft.draftId}`).set(AUTH).expect(200);
    expect(read.body).toMatchObject({ validatedRunId, validatedDeclared: true });

    await drain();
    expect(mailed()).toHaveLength(4);
    vi.mocked(declareRunOutcomes).mockClear();
    expect(await declareNewsletterUnits()).toMatchObject({ declared: 4, error: null });
    for (const [, , body] of vi.mocked(declareRunOutcomes).mock.calls) {
      expect(body.produced!.every((p) => p.outcomeKey === "newsletter_email_sent")).toBe(true);
      expect(body.consumed!.filter((c) => c.outcomeKey === "newsletter_validated")).toEqual([
        { outcomeKey: "newsletter_validated", subjectService: "transactional-email-service", subjectId: draft.draftId },
      ]);
    }
    expect(vi.mocked(declareRunOutcomes).mock.calls.flatMap(([, , b]) => b.produced!)).toHaveLength(4);

    const list = await request(app).get("/internal/mailing-list-releases").set({ "x-api-key": API_KEY }).expect(200);
    expect(list.body).toMatchObject({ draftedOutcomeKey: "newsletter_drafted", validatedOutcomeKey: "newsletter_validated" });
    expect(list.body.releases[0]).toMatchObject({ draftId: draft.draftId, draftedRunId: draft.draftedRunId, validatedRunId });

    // A second release from the same draft (this one completed) is not a second approval.
    const again = await createRelease({ ...DRAFT, dailyLimit: 100, draftId: draft.draftId });
    expect(again.status).toBe(201);
    expect(vi.mocked(createRun).mock.calls.filter(([p]) => p.taskName === "newsletter-validated")).toHaveLength(1);
  });

  it("a release with no draft consumes no validation (a test send is not an approval)", async () => {
    await seedList(2);
    await createRelease({ subject: "test", body: "test", dailyLimit: 100 });
    await drain();
    vi.mocked(declareRunOutcomes).mockClear();
    await declareNewsletterUnits();
    const consumed = vi.mocked(declareRunOutcomes).mock.calls.flatMap(([, , b]) => b.consumed ?? []);
    expect(consumed.map((c) => c.outcomeKey)).toEqual(["message_sent", "message_sent"]);
    expect(runOf("newsletter-validated")).toBeNull();
  });

  it("refuses a draft of another list or an unknown draft, and starts nothing", async () => {
    await seedList(1);
    await request(app).post(`/mailing-lists/other-list/subscribers`).set(AUTH).send({ raw: "x@example.com" }).expect(200);
    const other = (await registerDraft(DRAFT, "other-list")).body;
    const mismatch = await createRelease({ ...DRAFT, dailyLimit: 10, draftId: other.draftId });
    expect(mismatch.status).toBe(409);
    const unknown = await createRelease({ ...DRAFT, dailyLimit: 10, draftId: "3f0c9a52-0000-4000-8000-000000000000" });
    expect(unknown.status).toBe(404);
    expect(runOf("newsletter-validated")).toBeNull();
    const rows = await sql`SELECT id FROM mailing_list_releases`;
    expect(rows).toHaveLength(0);
  });
});

describe("relaunching a halted release to the subscribers it never sent to (NEWSLETTER-RELAUNCH-HALTED-1107)", () => {
  async function relaunch(releaseId: string, body: Record<string, unknown> = {}) {
    return request(app).post(`/mailing-lists/releases/${releaseId}/relaunch`).set(AUTH).send(body);
  }

  async function recipientsOf(releaseId: string): Promise<string[]> {
    const rows = await sql<Array<{ email: string }>>`
      SELECT email FROM mailing_list_release_recipients WHERE release_id = ${releaseId}::uuid ORDER BY email`;
    return rows.map((r) => r.email);
  }

  async function sentBy(releaseId: string): Promise<string[]> {
    const rows = await sql<Array<{ email: string }>>`
      SELECT email FROM mailing_list_release_recipients
      WHERE release_id = ${releaseId}::uuid AND status = 'sent' ORDER BY email`;
    return rows.map((r) => r.email);
  }

  async function halt(releaseId: string) {
    await sql`
      UPDATE mailing_list_releases SET status = 'halted', halted_reason = '5.01% of messages bounced'
      WHERE id = ${releaseId}::uuid`;
  }

  /** A 50-address list whose release sent its first day (10) and then halted. */
  async function haltedAfterADay() {
    await seedList(50);
    const created = await createRelease({ subject: "0% markup", body: "# Big news", dailyLimit: 10 });
    expect(created.status).toBe(201);
    await drain();
    const releaseId = created.body.releaseId as string;
    const sent = await sentBy(releaseId);
    expect(sent).toHaveLength(10);
    await halt(releaseId);
    return { releaseId, sent };
  }

  it("creates a release whose recipients are the list minus exactly the addresses the halted one sent to", async () => {
    const { releaseId, sent } = await haltedAfterADay();

    const res = await relaunch(releaseId);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.relaunchedFromReleaseId).toBe(releaseId);
    expect(res.body.releaseId).not.toBe(releaseId);
    expect(res.body.status).toBe("running");
    expect(res.body.recipientCount).toBe(40);

    const expected = addresses(50).filter((a) => !sent.includes(a)).sort();
    expect(await recipientsOf(res.body.releaseId)).toEqual(expected);

    // The halted release is left exactly as it was: it never resumes.
    expect((await readRelease(releaseId)).status).toBe("halted");
  });

  it("never mails anyone the halted release reached, and reaches everyone else", async () => {
    const { releaseId, sent } = await haltedAfterADay();
    const res = await relaunch(releaseId, { dailyLimit: 100 });
    expect(res.body.dailyLimit).toBe(100);

    vi.mocked(sendEmail).mockClear();
    await drain();

    const reached = mailed();
    expect(reached.filter((a) => sent.includes(a))).toEqual([]);
    expect([...reached].sort()).toEqual(addresses(50).filter((a) => !sent.includes(a)).sort());
    expect((await readRelease(res.body.releaseId)).status).toBe("completed");
  });

  it("keeps the source's content, sender and payer, on a run of its own", async () => {
    const { releaseId } = await haltedAfterADay();
    const [source] = await sql<Array<Record<string, unknown>>>`SELECT * FROM mailing_list_releases WHERE id = ${releaseId}::uuid`;

    const res = await relaunch(releaseId);
    const [copy] = await sql<Array<Record<string, unknown>>>`SELECT * FROM mailing_list_releases WHERE id = ${res.body.releaseId}::uuid`;

    for (const col of ["subject", "from_address", "body_kind", "body_markdown", "html_body", "text_body", "dedup_key", "org_id", "user_id", "daily_limit"]) {
      expect(copy[col]).toEqual(source[col]);
    }
    expect(copy.run_id).not.toEqual(source.run_id);
  });

  it("counts as sent a claim still in flight and one the worker died holding, and re-includes skipped, failed and new subscribers", async () => {
    await seedList(10);
    const created = await createRelease({ subject: "mixed", body: "hi", dailyLimit: 10 });
    const releaseId = created.body.releaseId as string;
    const set = (email: string, status: string, reason: string | null = null) =>
      sql`UPDATE mailing_list_release_recipients SET status = ${status}, reason = ${reason}
          WHERE release_id = ${releaseId}::uuid AND email = ${email}`;
    const [a, b, c, d, e, f] = addresses(10);
    await set(a, "sent");
    await set(b, "sending");
    await set(c, "failed", (await import("../../src/lib/release-pacing.js")).INTERRUPTED_REASON);
    await set(d, "failed", "gateway 422");
    await set(e, "skipped_opted_out", "ManualSuppression");
    await set(f, "skipped_undeliverable");
    await halt(releaseId);
    await request(app).post(`/mailing-lists/${SLUG}/subscribers`).set(AUTH).send({ raw: "joined.later@example.com" }).expect(200);

    const res = await relaunch(releaseId);
    expect(res.status).toBe(201);
    const recipients = await recipientsOf(res.body.releaseId);
    expect(recipients).not.toContain(a);
    expect(recipients).not.toContain(b);
    expect(recipients).not.toContain(c);
    expect(recipients).toEqual(expect.arrayContaining([d, e, f, "joined.later@example.com"]));
    expect(recipients).toHaveLength(11 - 3);
  });

  it("a relaunch of a relaunch excludes what every ancestor sent", async () => {
    const { releaseId, sent: firstDay } = await haltedAfterADay();
    const second = await relaunch(releaseId);
    await drain();
    const secondDay = await sentBy(second.body.releaseId);
    expect(secondDay).toHaveLength(10);
    await halt(second.body.releaseId);

    const third = await relaunch(second.body.releaseId);
    expect(third.status).toBe(201);
    const recipients = await recipientsOf(third.body.releaseId);
    expect(recipients).toHaveLength(30);
    expect(recipients.filter((r) => firstDay.includes(r) || secondDay.includes(r))).toEqual([]);
  });

  it("returns the existing relaunch when asked twice, rather than starting a second one", async () => {
    const { releaseId } = await haltedAfterADay();
    const first = await relaunch(releaseId);
    const again = await relaunch(releaseId);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.releaseId).toBe(first.body.releaseId);
    const [{ count }] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM mailing_list_releases WHERE relaunched_from_release_id = ${releaseId}::uuid`;
    expect(count).toBe(1);
  });

  it("refuses a release still running, one that completed, and one whose whole list was already sent", async () => {
    await seedList(5);
    const running = await createRelease({ subject: "live", body: "hi", dailyLimit: 100 });
    const r1 = await relaunch(running.body.releaseId);
    expect(r1.status).toBe(409);
    expect(r1.body.error).toContain("running");

    await drain();
    expect((await readRelease(running.body.releaseId)).status).toBe("completed");
    const r2 = await relaunch(running.body.releaseId);
    expect(r2.status).toBe(409);
    expect(r2.body.error).toContain("finished");

    await halt(running.body.releaseId);
    const r3 = await relaunch(running.body.releaseId);
    expect(r3.status).toBe(409);
    expect(r3.body.error).toContain("already sent");
  });

  it("answers 404 for a release that does not exist, 400 for a pace the worker cannot deliver, 401 without a key", async () => {
    const missing = await relaunch("00000000-0000-4000-8000-000000000000");
    expect(missing.status).toBe(404);
    const { releaseId } = await haltedAfterADay();
    const tooFast = await relaunch(releaseId, { dailyLimit: MAX_DAILY_LIMIT + 1 });
    expect(tooFast.status).toBe(400);
    await request(app).post(`/mailing-lists/releases/${releaseId}/relaunch`).send({}).expect(401);
  });
});

describe("every release runs under a campaign (NEWSLETTER-CAMPAIGN-1108)", () => {
  const NO_CAMPAIGN = { "x-api-key": API_KEY, "x-org-id": "org_test", "x-user-id": "user_staff" };

  it("refuses a release that names no campaign, and writes nothing", async () => {
    await seedList(5);
    vi.mocked(createRun).mockClear();

    const res = await request(app)
      .post(`/mailing-lists/${SLUG}/releases`)
      .set(NO_CAMPAIGN)
      .send({ subject: "No campaign", body: "# Hello", dailyLimit: 10 });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("campaign_required");
    expect(vi.mocked(createRun)).not.toHaveBeenCalled();
    const rows = await sql`SELECT id FROM mailing_list_releases`;
    expect(rows).toHaveLength(0);
  });

  it("books the release, its run and every downstream call on the campaign it names", async () => {
    await seedList(5);
    vi.mocked(createRun).mockClear();

    const res = await createRelease({ subject: "With campaign", body: "# Hello", dailyLimit: 10 });
    expect(res.status).toBe(201);

    const [row] = await sql<Array<{ campaign_id: string; brand_ids: string[] }>>`
      SELECT campaign_id, brand_ids FROM mailing_list_releases WHERE id = ${res.body.releaseId}::uuid`;
    expect(row.campaign_id).toBe("campaign_newsletter");
    // No x-brand-id on the request: the campaign's brands are the release's.
    expect(row.brand_ids).toEqual(["brand_of_campaign"]);
    expect(vi.mocked(createRun).mock.calls[0][0]).toMatchObject({ campaignId: "campaign_newsletter", brandIds: ["brand_of_campaign"] });

    vi.mocked(fetchVerdicts).mockClear();
    await drain();
    const verifiedFor = vi.mocked(fetchVerdicts).mock.calls[0][0] as { campaignId: string };
    expect(verifiedFor.campaignId).toBe("campaign_newsletter");
  });

  it("relaunches a campaign-less halted release under the campaign the relaunch names, and refuses one that names none", async () => {
    await seedList(20);
    const created = await createRelease({ subject: "Old issue", body: "# Old", dailyLimit: 5 });
    expect(created.status).toBe(201);
    const releaseId = created.body.releaseId as string;
    // A release started before campaigns were required.
    await sql`UPDATE mailing_list_releases SET campaign_id = NULL, status = 'halted', halted_reason = 'bounced' WHERE id = ${releaseId}::uuid`;

    const refused = await request(app).post(`/mailing-lists/releases/${releaseId}/relaunch`).set(NO_CAMPAIGN).send({});
    expect(refused.status).toBe(400);
    expect(refused.body.reason).toBe("campaign_required");

    const res = await request(app).post(`/mailing-lists/releases/${releaseId}/relaunch`).set(AUTH).send({});
    expect(res.status).toBe(201);
    const [row] = await sql<Array<{ campaign_id: string }>>`
      SELECT campaign_id FROM mailing_list_releases WHERE id = ${res.body.releaseId}::uuid`;
    expect(row.campaign_id).toBe("campaign_newsletter");
  });
});
