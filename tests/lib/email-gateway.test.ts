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
      runId: "run_abc",
      brandId: "brand_123",
      campaignId: "campaign_456",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(url).toContain("/send");
    expect(body).toMatchObject({
      type: "transactional",
      to: "test@example.com",
      subject: "Test subject",
      clerkOrgId: "org_123",
      runId: "run_abc",
      brandId: "brand_123",
      campaignId: "campaign_456",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "user_active",
      recipientFirstName: "",
      recipientLastName: "",
      recipientCompany: "",
    });
  });

  it("maps orgId to clerkOrgId in the payload", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_real_123",
      runId: "run_abc",
      brandId: "lifecycle",
      campaignId: "lifecycle-test",
    });

    const [, options] = fetchSpy.mock.calls[0];
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
      runId: "run_abc",
    });

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.from).toBeUndefined();
  });

  it("includes all required fields for email gateway", async () => {
    await sendEmail({
      to: "test@example.com",
      subject: "Test",
      htmlBody: "<p>Test</p>",
      textBody: "Test",
      tag: "test-tag",
      orgId: "org_xyz",
      runId: "run_abc",
      brandId: "brand_xyz",
      campaignId: "campaign_789",
    });

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.type).toBe("transactional");
    expect(body.brandId).toBe("brand_xyz");
    expect(body.campaignId).toBe("campaign_789");
    expect(body.recipientFirstName).toBe("");
    expect(body.recipientLastName).toBe("");
    expect(body.recipientCompany).toBe("");
  });
});
