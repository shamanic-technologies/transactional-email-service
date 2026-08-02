import { describe, it, expect } from "vitest";
import { parseAddressBlob } from "../../src/lib/address-blob.js";

describe("parseAddressBlob", () => {
  it("reads a comma-separated blob", () => {
    const result = parseAddressBlob("a@example.com, b@example.com");
    expect(result.emails).toEqual(["a@example.com", "b@example.com"]);
    expect(result.rejected).toEqual([]);
  });

  it("reads a newline-separated blob", () => {
    const result = parseAddressBlob("a@example.com\nb@example.com\r\nc@example.com");
    expect(result.emails).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
  });

  it("reads `Name <email>` pairs", () => {
    const result = parseAddressBlob("Ada Lovelace <ada@example.com>, <grace@example.com>");
    expect(result.emails).toEqual(["ada@example.com", "grace@example.com"]);
  });

  it("reads a bare `Name email` pair with no angle brackets", () => {
    const result = parseAddressBlob("Ada Lovelace ada@example.com");
    expect(result.emails).toEqual(["ada@example.com"]);
  });

  it("tolerates trailing semicolons, tabs and blank fragments", () => {
    const result = parseAddressBlob("a@example.com;\t b@example.com;;\n\n");
    expect(result.emails).toEqual(["a@example.com", "b@example.com"]);
    expect(result.rejected).toEqual([]);
  });

  it("lower-cases addresses and de-duplicates within the blob", () => {
    const result = parseAddressBlob("A@Example.com, a@example.com, Ada <A@EXAMPLE.COM>");
    expect(result.emails).toEqual(["a@example.com"]);
    expect(result.duplicates).toEqual(["a@example.com", "a@example.com"]);
  });

  it("reports fragments it cannot read rather than dropping them", () => {
    const result = parseAddressBlob("good@example.com, not-an-email, also bad@, @nope.com");
    expect(result.emails).toEqual(["good@example.com"]);
    expect(result.rejected.map((r) => r.value)).toEqual(["not-an-email", "also bad@", "@nope.com"]);
    expect(result.rejected[0].reason).toBe("not a valid email address");
  });

  it("handles a messy real-world paste", () => {
    const raw = `
      Kevin Lourd <kevin@example.com>;
      investor.two@fund.co.uk,
      "Third Person" third@vc.io
      garbage line
      kevin@example.com
    `;
    const result = parseAddressBlob(raw);
    expect(result.emails).toEqual(["kevin@example.com", "investor.two@fund.co.uk", "third@vc.io"]);
    expect(result.duplicates).toEqual(["kevin@example.com"]);
    expect(result.rejected.map((r) => r.value)).toEqual(["garbage line"]);
  });

  it("returns nothing for an all-garbage blob", () => {
    const result = parseAddressBlob("hello world");
    expect(result.emails).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });
});
