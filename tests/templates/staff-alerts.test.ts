import { describe, it, expect, vi } from "vitest";

const { mockOnConflictDoUpdate, mockValues, mockInsert } = vi.hoisted(() => {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  return { mockOnConflictDoUpdate, mockValues, mockInsert };
});

vi.mock("../../src/db/index.js", () => ({ db: { insert: mockInsert } }));

import { PROVIDER_CREDITS_EXHAUSTED_TEMPLATE, STAFF_TEMPLATES, seedStaffTemplates } from "../../src/templates/staff-alerts.js";
import { interpolate } from "../../src/templates/index.js";

const TPL = PROVIDER_CREDITS_EXHAUSTED_TEMPLATE;

describe("provider_credits_exhausted template", () => {
  it("is registered under the exact event-type string the endpoint accepts", () => {
    expect(TPL.name).toBe("provider_credits_exhausted");
    expect(STAFF_TEMPLATES).toContain(TPL);
  });

  it("renders every fact the alert carries", () => {
    const metadata = {
      provider: "Apollo.io",
      reason: "people/search returned 402 with credits_remaining: 0",
      detail: 'HTTP 402 {"error":"insufficient_credits"}',
      orgId: "org_456",
    };

    const subject = interpolate(TPL.subject, metadata);
    const html = interpolate(TPL.htmlBody, metadata);
    const text = interpolate(TPL.textBody, metadata);

    expect(subject).toBe("Apollo.io is out of credits");
    for (const value of Object.values(metadata)) {
      expect(html).toContain(value);
      expect(text).toContain(value);
    }
  });

  it("leaves no placeholder behind when the optional upstream detail is absent", () => {
    const html = interpolate(TPL.htmlBody, { provider: "Apollo.io", reason: "402", orgId: "org_456" });
    expect(html).not.toContain("{{");
  });

  it("is styled the only way mail clients honour: inline, on tables", () => {
    // Gmail drops <head> and <style>; Outlook ignores classes
    expect(TPL.htmlBody).not.toContain("<style");
    expect(TPL.htmlBody).not.toContain("class=");
    expect(TPL.htmlBody).not.toContain("flex");
    expect(TPL.htmlBody).not.toContain("grid");
    expect(TPL.htmlBody).toContain("<table");
    // Fixed layout + stated widths: a long raw payload cannot widen the document
    // past a 375px screen, which automatic table layout would let it do
    expect(TPL.htmlBody).toContain("table-layout:fixed");
    expect(TPL.htmlBody).toContain("width:100%");
    expect(TPL.htmlBody).toContain("word-break:break-all");
  });

  it("carries a plain-text part, so the alert is readable with images and HTML off", () => {
    expect(TPL.textBody.length).toBeGreaterThan(0);
    expect(TPL.textBody).not.toContain("<");
  });
});

describe("seedStaffTemplates", () => {
  it("upserts every staff template by name, so a shipped edit lands on boot", async () => {
    await seedStaffTemplates();

    expect(mockInsert).toHaveBeenCalledTimes(STAFF_TEMPLATES.length);
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ name: "provider_credits_exhausted", subject: TPL.subject, htmlBody: TPL.htmlBody }),
    );
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.objectContaining({ htmlBody: TPL.htmlBody }) }),
    );
  });
});
