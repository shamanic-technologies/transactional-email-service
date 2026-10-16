import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockValues, mockOnConflict, mockReturning, mockSet, mockWhere, mockSelectLimit } = vi.hoisted(() => {
  process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "test-api-key";
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-service-key";
  return {
    mockValues: vi.fn(),
    mockOnConflict: vi.fn(),
    mockReturning: vi.fn(),
    mockSet: vi.fn(),
    mockWhere: vi.fn(),
    mockSelectLimit: vi.fn(),
  };
});

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({ values: mockValues })),
    update: vi.fn(() => ({ set: mockSet })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockSelectLimit })) })) })),
  },
}));

vi.mock("../../src/lib/client-service.js", () => ({ resolveUserEmail: vi.fn() }));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  createPlatformRun: vi.fn(),
  updatePlatformRun: vi.fn(),
}));

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn() }));

import request from "supertest";
import express from "express";
import sendRoutes from "../../src/routes/send.js";
import { createRun, createPlatformRun, updatePlatformRun } from "../../src/lib/runs-client.js";
import { resolveUserEmail } from "../../src/lib/client-service.js";
import { ADMIN_EMAILS } from "../../src/lib/staff-recipients.js";
import { SENDING_DOMAIN_BLOCKLISTED_TEMPLATE as TPL } from "../../src/templates/staff-alerts.js";

const app = express();
app.use(express.json());
app.use(sendRoutes);

const METADATA = {
  domain: "boostdistribute.com",
  listName: "SURBL",
  listedSince: "2026-10-16",
  listAnswer: "ABUSE",
  mailboxesAffected: "ruth@boostdistribute.com, kevin@boostdistribute.com",
  actionTaken: "The 2 mailboxes no longer start new sequences.",
  removalUrl: "https://www.surbl.org/surbl-analysis",
};

const BODY = { eventType: "sending_domain_blocklisted", eventId: "boostdistribute.com:SURBL:2026-10-16", metadata: METADATA };

let fetchSpy: ReturnType<typeof vi.fn>;

function post(body: unknown, headers: Record<string, string> = {}) {
  return request(app).post("/platform-staff-alert").set("X-API-Key", "test-service-key").set(headers).send(body as object);
}

function gatewayCalls() {
  return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/platform/send"));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal("fetch", fetchSpy);
  mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflict });
  mockOnConflict.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([{ id: "event-row-1" }]);
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockResolvedValue(undefined);
  mockSelectLimit.mockResolvedValue([{ ...TPL, fromAddress: null, layout: "none", stream: "broadcast" }]);
  vi.mocked(createPlatformRun).mockResolvedValue({ id: "platform-run-1" } as never);
  vi.mocked(updatePlatformRun).mockResolvedValue({} as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /platform-staff-alert", () => {
  it("delivers one email to the staff list with no org and no user, on a platform run", async () => {
    const res = await post(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, duplicate: false, eventId: BODY.eventId, runId: "platform-run-1" });
    expect(createPlatformRun).toHaveBeenCalledWith({ serviceName: "transactional-email-service", taskName: "email-sending_domain_blocklisted" });
    expect(createRun).not.toHaveBeenCalled();
    expect(resolveUserEmail).not.toHaveBeenCalled();
    expect(updatePlatformRun).toHaveBeenCalledWith("platform-run-1", "completed");

    const calls = gatewayCalls();
    expect(calls).toHaveLength(ADMIN_EMAILS.length);
    const [, options] = calls[0];
    expect(options.headers["x-org-id"]).toBeUndefined();
    expect(options.headers["x-user-id"]).toBeUndefined();
    expect(options.headers["x-run-id"]).toBe("platform-run-1");
    const sent = JSON.parse(options.body);
    expect(sent.to).toBe(ADMIN_EMAILS[0]);
    expect(sent.subject).toBe("boostdistribute.com is on the SURBL blocklist");
    expect(sent.bcc).toBeUndefined();
    expect(sent.cc).toBeUndefined();
    for (const value of Object.values(METADATA)) {
      expect(sent.textBody).toContain(value);
      expect(sent.htmlBody).toContain(value);
    }
    expect(sent.htmlBody).toContain(`href="${METADATA.removalUrl}"`);
    // Staff mail: no brand layout, no why sign-off
    expect(sent.textBody).not.toContain("Revenue made easy");

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sending_domain_blocklisted",
        orgId: null,
        userId: null,
        dedupKey: `platform-staff-alert:sending_domain_blocklisted:${BODY.eventId}`,
        status: "pending",
      }),
    );
    expect(mockSet).toHaveBeenLastCalledWith({ status: "sent" });
  });

  it("claims only a NEW or a FAILED occurrence: a sent one is never reclaimed", async () => {
    await post(BODY);
    const [[conflict]] = mockOnConflict.mock.calls;
    expect(conflict.set).toMatchObject({ status: "pending", errorMessage: null });
    expect(conflict.setWhere).toBeDefined();
  });

  it("the same event id twice delivers once, and the second answer says duplicate", async () => {
    const first = await post(BODY);
    expect(first.status).toBe(200);
    expect(first.body.sent).toBe(true);

    // The occurrence is now sent: the conflict update's setWhere (status = failed) matches nothing
    mockReturning.mockResolvedValueOnce([]);
    const second = await post(BODY);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ sent: false, duplicate: true, eventId: BODY.eventId, runId: null });
    expect(gatewayCalls()).toHaveLength(ADMIN_EMAILS.length);
    expect(createPlatformRun).toHaveBeenCalledTimes(1);
  });

  it("a failed delivery is a 502 that leaves the event id free for the retry", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
    const res = await post(BODY);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("delivery_failed");
    expect(mockSet).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" }));
    expect(updatePlatformRun).toHaveBeenCalledWith("platform-run-1", "failed", expect.any(String));

    // The retry reclaims the failed row and sends
    const retry = await post(BODY);
    expect(retry.status).toBe(200);
    expect(retry.body.sent).toBe(true);
  });

  it("a run that cannot be opened is a 502 and frees the event id", async () => {
    vi.mocked(createPlatformRun).mockRejectedValueOnce(new Error("runs down"));
    const res = await post(BODY);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("run_failed");
    expect(gatewayCalls()).toHaveLength(0);
    expect(mockSet).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("a missing required field is a 400 naming it", async () => {
    const { removalUrl: _r, domain: _d, ...rest } = METADATA;
    const res = await post({ ...BODY, metadata: { ...rest, listName: "  " } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_metadata");
    expect(res.body.missing).toEqual(["domain", "listName", "removalUrl"]);
    expect(res.body.error).toContain("domain");
    expect(gatewayCalls()).toHaveLength(0);
    expect(mockValues).not.toHaveBeenCalled();
  });

  it("a missing event id is a 400", async () => {
    const { eventId: _e, ...rest } = BODY;
    const res = await post(rest);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
  });

  it("refuses an organisation or a user: the fact belongs to none", async () => {
    const res = await post(BODY, { "x-org-id": "org-1" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("org_identity_not_accepted");
    const res2 = await post(BODY, { "x-user-id": "user-1" });
    expect(res2.body.code).toBe("org_identity_not_accepted");
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("refuses a caller-chosen recipient: the staff list stays ours", async () => {
    const res = await post({ ...BODY, recipientEmail: "someone@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("refuses an event type outside the closed list", async () => {
    const res = await post({ ...BODY, eventType: "welcome" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("event_not_platform_staff_alert");
  });

  it("requires the service key", async () => {
    const res = await request(app).post("/platform-staff-alert").send(BODY);
    expect(res.status).toBe(401);
  });
});
