import { z } from "zod";

// REP-REPLY-1127: a send can name SEVERAL Reply-To addresses (display names
// allowed) and the message it answers (In-Reply-To + References). The
// consumer is instantly-service's positive-reply email to a sales rep: the
// rep hits Reply in their own mail app and writes to the prospect AND to our
// thread's sending mailbox, inside the prospect's existing conversation.
//
// Addresses travel STRUCTURED ({name?, email}) all the way to email-gateway,
// which renders the one RFC 5322 Reply-To header (quoting every display name).
// Nothing here parses or joins a header string: a comma inside a name can
// never split one address into two. A line break in a name is refused
// (header injection), as the gateway also does.

export const MAX_REPLY_TO_ADDRESSES = 10;
export const MAX_REFERENCES = 50;

export const ReplyToAddressSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => !/[\r\n]/.test(v), "name must not contain a line break")
    .optional()
    .describe("Display name, e.g. \"Jane Doe\". Absent = the bare address."),
  email: z.string().email().describe("The address"),
});

export type ReplyToAddress = z.infer<typeof ReplyToAddressSchema>;

export const ReplyToAddressesSchema = z.array(ReplyToAddressSchema).min(1).max(MAX_REPLY_TO_ADDRESSES);

export const MessageIdSchema = z
  .string()
  .regex(/^<[^<>\s]+@[^<>\s]+>$/, "must be a RFC 5322 Message-ID enclosed in angle brackets, e.g. <id@host>");

/** The gateway's `replyTo` list: only the keys the caller stated, in its order. */
export function gatewayReplyTo(addresses: readonly ReplyToAddress[]): ReplyToAddress[] {
  return addresses.map(({ name, email }) => (name ? { name, email } : { email }));
}
