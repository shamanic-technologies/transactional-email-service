import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "test-api-key";
});

import { sendEmail } from "../../src/lib/email-gateway.js";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendEmail", () => {
  it("sends a transactional email via the email gateway", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test subject",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "user_active",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_abc",
      brandIds: ["brand_123"],
      campaignId: "campaign_456",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(url).toContain("/orgs/send");
    expect(body).toMatchObject({
      type: "transactional",
      to: "test@example.com",
      subject: "Test subject",
      clerkOrgId: "org_123",
      runId: "run_abc",
      campaignId: "campaign_456",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "user_active",
      recipientFirstName: "",
      recipientLastName: "",
      recipientCompany: "",
    });
    expect(body.brandIds).toBeUndefined();
  });

  it("forwards x-org-id, x-user-id, and x-run-id headers", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_real_123",
      userId: "user_real_456",
      runId: "run_abc",
      brandIds: ["lifecycle"],
      campaignId: "lifecycle-test",
    });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-org-id"]).toBe("org_real_123");
    expect(options.headers["x-user-id"]).toBe("user_real_456");
    expect(options.headers["x-run-id"]).toBe("run_abc");

    const body = JSON.parse(options.body);
    expect(body.clerkOrgId).toBe("org_real_123");
    expect(body.runId).toBe("run_abc");
  });

  it("passes from to email gateway when provided", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_abc",
      from: "GrowthAgency <hello@growthagency.dev>",
    });

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.from).toBe("GrowthAgency <hello@growthagency.dev>");
  });

  it("omits from when not provided", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_abc",
    });

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.from).toBeUndefined();
  });

  it("passes bcc to email gateway when provided", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_abc",
      bcc: "alpha1@example.com,alpha2@example.com",
    });

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.bcc).toBe("alpha1@example.com,alpha2@example.com");
  });

  it("adds staff bcc from TRANSACTIONAL_BCC_EMAILS when no caller bcc", async () => {
    process.env.TRANSACTIONAL_BCC_EMAILS = "staff1@distribute.you,staff2@distribute.you";
    try {
      await sendEmail({
        to: "test@example.com",
        subject: "Test",
        htmlBody: "<p>Test</p>",
        textBody: "Test",
        tag: "test-tag",
        orgId: "org_123",
        userId: "user_456",
        runId: "run_abc",
      });
    } finally {
      delete process.env.TRANSACTIONAL_BCC_EMAILS;
    }

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.bcc).toBe("staff1@distribute.you,staff2@distribute.you");
  });

  it("merges and de-dups caller bcc with TRANSACTIONAL_BCC_EMAILS", async () => {
    process.env.TRANSACTIONAL_BCC_EMAILS = " staff@distribute.you , alpha1@example.com ";
    try {
      await sendEmail({
        to: "test@example.com",
        subject: "Test",
        htmlBody: "<p>Test</p>",
        textBody: "Test",
        tag: "test-tag",
        orgId: "org_123",
        userId: "user_456",
        runId: "run_abc",
        bcc: "alpha1@example.com,alpha2@example.com",
      });
    } finally {
      delete process.env.TRANSACTIONAL_BCC_EMAILS;
    }

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    // caller addresses first, then env-only address; alpha1 not duplicated
    expect(body.bcc).toBe("alpha1@example.com,alpha2@example.com,staff@distribute.you");
  });

  it("omits bcc when neither caller bcc nor TRANSACTIONAL_BCC_EMAILS is set", async () => {
    delete process.env.TRANSACTIONAL_BCC_EMAILS;
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_abc",
    });

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.bcc).toBeUndefined();
  });

  it("includes all required fields for email gateway", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_xyz",
      userId: "user_xyz",
      runId: "run_abc",
      brandIds: ["brand_xyz"],
      campaignId: "campaign_789",
    });

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.type).toBe("transactional");
    expect(body.brandIds).toBeUndefined();
    expect(body.campaignId).toBe("campaign_789");
    expect(body.recipientFirstName).toBe("");
    expect(body.recipientLastName).toBe("");
    expect(body.recipientCompany).toBe("");
  });

  it("forwards workflow tracking headers when provided", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_abc",
      workflowHeaders: {
        campaignId: "camp_123",
        brandId: "brand_456,brand_789",
        workflowSlug: "onboarding-flow",
      },
    });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-campaign-id"]).toBe("camp_123");
    expect(options.headers["x-brand-id"]).toBe("brand_456,brand_789");
    expect(options.headers["x-workflow-slug"]).toBe("onboarding-flow");
  });

  it("forwards x-audience-id header when audienceId is provided", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_abc",
      workflowHeaders: { audienceId: "aud_priority_1" },
    });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-audience-id"]).toBe("aud_priority_1");
  });

  it("does not send brandIds in request body (brand goes via x-brand-id header only)", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "campaign_created",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_abc",
      brandIds: ["brand_1", "brand_2"],
      workflowHeaders: { brandId: "brand_1,brand_2" },
    });

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    // brandIds must NOT appear in body — gateway schema doesn't accept it
    // and downstream postmark-service rejects arrays for brandId
    expect(body.brandIds).toBeUndefined();
    expect(body.brandId).toBeUndefined();

    // brand tracking goes via header only
    expect(options.headers["x-brand-id"]).toBe("brand_1,brand_2");
  });

  it("omits workflow headers when not provided", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_123",
      userId: "user_456",
      runId: "run_abc",
    });

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-campaign-id"]).toBeUndefined();
    expect(options.headers["x-brand-id"]).toBeUndefined();
    expect(options.headers["x-workflow-slug"]).toBeUndefined();
    expect(options.headers["x-audience-id"]).toBeUndefined();
  });
});
