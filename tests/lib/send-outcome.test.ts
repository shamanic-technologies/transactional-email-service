import { describe, it, expect } from "vitest";
import { gatewaySendError, isSendOutcomeUnknown, SendOutcomeUnknownError } from "../../src/lib/send-outcome.js";

describe("gatewaySendError", () => {
  it("a 504 send_outcome_unknown is an unknown outcome, never a plain failure", () => {
    const err = gatewaySendError(504, { error: "timeout", code: "send_outcome_unknown" });
    expect(err).toBeInstanceOf(SendOutcomeUnknownError);
    expect(isSendOutcomeUnknown(err)).toBe(true);
    expect(err.message).toContain("504");
  });

  it("any other refusal stays a plain failure", () => {
    expect(isSendOutcomeUnknown(gatewaySendError(502, { error: "Upstream service error" }))).toBe(false);
    expect(isSendOutcomeUnknown(gatewaySendError(504, { error: "gateway timeout" }))).toBe(false);
    expect(isSendOutcomeUnknown(gatewaySendError(422, { code: "send_outcome_unknown" }))).toBe(false);
  });
});
