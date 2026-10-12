import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockValues, mockReturning, mockSet, mockWhere, mockSelectLimit } = vi.hoisted(() => {
  process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "test-api-key";
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-service-key";
  const mockReturning = vi.fn();
  const mockValues = vi.fn();
  const mockWhere = vi.fn();
  const mockSet = vi.fn();
  const mockSelectLimit = vi.fn();
  return { mockValues, mockReturning, mockSet, mockWhere, mockSelectLimit };
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

const app = express();
app.use(express.json());
app.use(sendRoutes);

const SIGNUP_TEMPLATE = {
  name: "agent_signup_code",
  subject: "Your distribute.you code: {{code}}",
  htmlBody: "<p>Your code is {{code}}. It expires in {{expiresInMinutes}} minutes.</p>",
  textBody: "Your code is {{code}}. It expires in {{expiresInMinutes}} minutes.",
  fromAddress: null,
  layout: "brand",
  stream: "transactional",
};

const BODY = {
  eventType: "agent_signup_code",
  recipientEmail: "agent-test@distribute.you",
  metadata: { code: "482913", expiresInMinutes: 15 },
};

let fetchSpy: ReturnType<typeof vi.fn>;

function post(body: unknown, headers: Record<string, string> = {}) {
  return request(app).post("/platform-orgless-send").set("X-API-Key", "test-service-key").set(headers).send(body as object);
}

function gatewayCalls() {
  return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/platform/send"));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal("fetch", fetchSpy);
  mockValues.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([{ id: "event-1" }]);
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockResolvedValue(undefined);
  mockSelectLimit.mockResolvedValue([SIGNUP_TEMPLATE]);
  vi.mocked(createPlatformRun).mockResolvedValue({ id: "platform-run-1" } as never);
  vi.mocked(updatePlatformRun).mockResolvedValue({} as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /platform-orgless-send", () => {
  it("sends the allowlisted template with no org and no user, on a platform run", async () => {
    const res = await post(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, eventId: "event-1", runId: "platform-run-1" });
    expect(createPlatformRun).toHaveBeenCalledWith({ serviceName: "transactional-email-service", taskName: "email-agent_signup_code" });
    expect(createRun).not.toHaveBeenCalled();
    expect(updatePlatformRun).toHaveBeenCalledWith("platform-run-1", "completed");

    const [[, options]] = gatewayCalls();
    expect(options.headers["x-org-id"]).toBeUndefined();
    expect(options.headers["x-user-id"]).toBeUndefined();
    expect(options.headers["x-run-id"]).toBe("platform-run-1");
    expect(gatewayCalls()[0][0]).toMatch(/\/platform\/send$/);
    const sent = JSON.parse(options.body);
    expect(sent.type).toBe("transactional");
    expect(sent.clerkOrgId).toBeUndefined();
    expect(sent.to).toBe("agent-test@distribute.you");
    expect(sent.subject).toBe("Your distribute.you code: 482913");
    expect(sent.textBody).toContain("expires in 15 minutes");
    expect(sent.tag).toBe("agent_signup_code");
  });

  it("adds no blind copy and no visible copy: a one-time code reaches only its owner", async () => {
    await post(BODY);
    const sent = JSON.parse(gatewayCalls()[0][1].body);
    expect(sent.bcc).toBeUndefined();
    expect(sent.cc).toBeUndefined();
  });

  it("records the send with no org and no dedup key", async () => {
    await post(BODY);
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, userId: null, dedupKey: null, eventType: "agent_signup_code" }));
    expect(mockSet).toHaveBeenLastCalledWith({ status: "sent" });
  });

  it("is not deduplicated: the same call twice delivers twice", async () => {
    expect((await post(BODY)).status).toBe(200);
    expect((await post(BODY)).status).toBe(200);
    expect(gatewayCalls()).toHaveLength(2);
  });

  it("refuses an event type outside the allowlist with a named error", async () => {
    const res = await post({ ...BODY, eventType: "welcome" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("event_not_orgless");
    expect(gatewayCalls()).toHaveLength(0);
    expect(createPlatformRun).not.toHaveBeenCalled();
  });

  it("refuses an org or a user on the request", async () => {
    for (const headers of [{ "x-org-id": "org_1" }, { "x-user-id": "user_1" }]) {
      const res = await post(BODY, headers);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("org_identity_not_accepted");
    }
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("refuses any extra field (no cc, bcc or reply-to on this path)", async () => {
    const res = await post({ ...BODY, bccEmails: ["x@example.com"] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
  });

  it("refuses missing or blank required metadata", async () => {
    const res = await post({ ...BODY, metadata: { code: " " } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_metadata");
    expect(res.body.error).toContain("code, expiresInMinutes");
  });

  it("404s with a named code when the template is not registered", async () => {
    mockSelectLimit.mockResolvedValue([]);
    const res = await post(BODY);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("template_not_found");
  });

  it("401s without the service key", async () => {
    const res = await request(app).post("/platform-orgless-send").send(BODY);
    expect(res.status).toBe(401);
  });

  it("fails loud with 502 when the gateway refuses, and marks run and row failed", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "nope" }) });
    const res = await post(BODY);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("delivery_failed");
    expect(updatePlatformRun).toHaveBeenCalledWith("platform-run-1", "failed", expect.stringContaining("400"));
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("fails loud with 502 when the platform run cannot be opened, and sends nothing", async () => {
    vi.mocked(createPlatformRun).mockRejectedValue(new Error("runs down"));
    const res = await post(BODY);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("run_failed");
    expect(gatewayCalls()).toHaveLength(0);
  });
});
