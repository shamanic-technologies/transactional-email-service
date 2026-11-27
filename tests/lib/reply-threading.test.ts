import { describe, expect, it } from "vitest";
import { gatewayReplyTo, MessageIdSchema, ReplyToAddressesSchema } from "../../src/lib/reply-threading.js";

describe("reply-threading", () => {
  it("keeps only the stated keys, in the caller's order", () => {
    expect(gatewayReplyTo([{ name: "Jane", email: "j@x.com" }, { email: "k@y.com" }])).toEqual([
      { name: "Jane", email: "j@x.com" },
      { email: "k@y.com" },
    ]);
  });

  it("refuses a name with a line break, a bad address, an empty or too long list", () => {
    expect(ReplyToAddressesSchema.safeParse([{ name: "A\nBcc: z@z.com", email: "a@x.com" }]).success).toBe(false);
    expect(ReplyToAddressesSchema.safeParse([{ email: "nope" }]).success).toBe(false);
    expect(ReplyToAddressesSchema.safeParse([]).success).toBe(false);
    expect(ReplyToAddressesSchema.safeParse(Array.from({ length: 11 }, (_, i) => ({ email: `a${i}@x.com` }))).success).toBe(false);
    expect(ReplyToAddressesSchema.safeParse([{ name: "Doe, Jane", email: "a@x.com" }]).success).toBe(true);
  });

  it("accepts only an angle-bracketed Message-ID", () => {
    expect(MessageIdSchema.safeParse("<a@b>").success).toBe(true);
    for (const bad of ["a@b", "<a b@c>", "<a@b>\r\n", ""]) expect(MessageIdSchema.safeParse(bad).success).toBe(false);
  });
});
