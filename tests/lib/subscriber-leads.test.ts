import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db/index.js", () => ({ sql: vi.fn(), db: {} }));

import { sql } from "../../src/db/index.js";
import { stateSubscriberLeads, EQUIVALENCE_REASON, STATED_BY } from "../../src/lib/subscriber-leads.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("stateSubscriberLeads", () => {
  const fetchMock = vi.fn();
  const runsCalls: any[] = [];

  beforeEach(() => {
    process.env.LEAD_SERVICE_URL = "http://lead";
    process.env.LEAD_SERVICE_API_KEY = "lk";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    runsCalls.length = 0;
    vi.mocked(sql).mockReset();
    vi.mocked(sql).mockResolvedValueOnce([
      { id: "s-both-a", email: "both@x.com" },
      { id: "s-both-b", email: "both@x.com" },
      { id: "s-lead", email: "lead@x.com" },
      { id: "s-none", email: "none@x.com" },
      { id: "s-amb", email: "amb@x.com" },
    ] as any);
  });
  afterEach(() => vi.unstubAllGlobals());

  function leadAnswers() {
    return async (body: { emails: string[] }) =>
      json({
        answers: body.emails.map((email) =>
          email === "none@x.com" ? { email, leadId: null, reason: "not_a_lead" }
          : email === "amb@x.com" ? { email, leadId: null, reason: "ambiguous" }
          : { email, leadId: `lead-of-${email}`, reason: null }
        ),
      });
  }

  it("states every subscriber whose address is a lead, each subscriber row on its own, and counts the rest", async () => {
    const lead = leadAnswers();
    fetchMock.mockImplementation(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (url === "http://lead/internal/leads/ids/by-email") {
        expect(init.headers["x-api-key"]).toBe("lk");
        expect(body.emails).toEqual(["both@x.com", "lead@x.com", "none@x.com", "amb@x.com"]);
        return lead(body);
      }
      runsCalls.push({ url, init, body });
      return json({ recordedCount: body.items.length, alreadyRecordedCount: 0 });
    });

    const report = await stateSubscriberLeads({ dryRun: false });

    expect(runsCalls).toHaveLength(1);
    expect(runsCalls[0].url).toMatch(/\/v1\/platform-runs\/subject-equivalences$/);
    expect(runsCalls[0].init.headers["x-service-name"]).toBe("transactional-email-service");
    expect(runsCalls[0].body).toEqual({
      reason: EQUIVALENCE_REASON,
      statedBy: STATED_BY,
      items: [
        { subjectService: "transactional-email-service", subjectId: "s-both-a", targetService: "lead-service", targetId: "lead-of-both@x.com" },
        { subjectService: "transactional-email-service", subjectId: "s-both-b", targetService: "lead-service", targetId: "lead-of-both@x.com" },
        { subjectService: "transactional-email-service", subjectId: "s-lead", targetService: "lead-service", targetId: "lead-of-lead@x.com" },
      ],
    });
    expect(report).toEqual({ dryRun: false, subscribers: 5, resolved: 3, notALead: 1, ambiguous: 1, recorded: 3, alreadyRecorded: 0, refused: [] });
  });

  it("a dry run resolves and counts, and states nothing", async () => {
    const lead = leadAnswers();
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (url.startsWith("http://lead")) return lead(JSON.parse(init.body));
      throw new Error(`unexpected call ${url}`);
    });
    const report = await stateSubscriberLeads({ dryRun: true });
    expect(report.resolved).toBe(3);
    expect(report.recorded).toBe(0);
  });

  it("a 422 drops only the refused items, reports them, and states the rest", async () => {
    const lead = leadAnswers();
    fetchMock.mockImplementation(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (url.startsWith("http://lead")) return lead(body);
      runsCalls.push(body);
      if (runsCalls.length === 1) {
        return json({ error: "invalid_equivalences", details: { refusals: [{ index: 2, reason: "conflicting_target" }] } }, 422);
      }
      return json({ recordedCount: 1, alreadyRecordedCount: 1 });
    });

    const report = await stateSubscriberLeads({ dryRun: false });

    expect(runsCalls).toHaveLength(2);
    expect(runsCalls[1].items.map((i: any) => i.subjectId)).toEqual(["s-both-a", "s-both-b"]);
    expect(report.refused).toEqual([{ subscriberId: "s-lead", leadId: "lead-of-lead@x.com", reason: "conflicting_target" }]);
    expect(report.recorded).toBe(1);
    expect(report.alreadyRecorded).toBe(1);
  });

  it("throws when lead-service fails or answers short", async () => {
    fetchMock.mockResolvedValueOnce(json({ answers: [] }));
    await expect(stateSubscriberLeads({ dryRun: true })).rejects.toThrow(/answered 0 answers for 4/);
  });

  it("throws on any runs-service failure other than a per-item refusal", async () => {
    const lead = leadAnswers();
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (url.startsWith("http://lead")) return lead(JSON.parse(init.body));
      return new Response("boom", { status: 500 });
    });
    await expect(stateSubscriberLeads({ dryRun: false })).rejects.toThrow(/500 - boom/);
  });
});
