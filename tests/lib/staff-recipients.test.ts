import { describe, it, expect } from "vitest";
import { ADMIN_EMAILS, STAFF_IDENTITIES, isStaffRecipientActor } from "../../src/lib/staff-recipients.js";

describe("isStaffRecipientActor", () => {
  it("matches the recipient address itself, trimmed and case-insensitive", () => {
    expect(isStaffRecipientActor("kevin.lourd@gmail.com", " KEVIN.lourd@gmail.com ")).toBe(true);
  });

  it("matches another address the same person acts under", () => {
    expect(isStaffRecipientActor("kevin.lourd@gmail.com", "kevin@distribute.you")).toBe(true);
  });

  it("does not match a customer, an empty actor or no actor", () => {
    expect(isStaffRecipientActor("kevin.lourd@gmail.com", "customer@example.com")).toBe(false);
    expect(isStaffRecipientActor("kevin.lourd@gmail.com", "  ")).toBe(false);
    expect(isStaffRecipientActor("kevin.lourd@gmail.com", undefined)).toBe(false);
  });

  it("identity aliases never add a recipient", () => {
    expect(ADMIN_EMAILS).toEqual(["kevin.lourd@gmail.com"]);
    for (const key of Object.keys(STAFF_IDENTITIES)) expect(ADMIN_EMAILS).toContain(key);
  });
});
