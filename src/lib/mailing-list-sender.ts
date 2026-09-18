/**
 * The sender an update leaves from when the caller states none.
 *
 * This is the address every update left from before a sender could be stated
 * per send, so a caller that says nothing sends exactly what it sent before.
 * It sits in its own module because the synchronous send and a paced release
 * must default identically — the same update should not leave from two
 * different addresses depending on which route sent it.
 */
export const DEFAULT_MAILING_LIST_FROM_ADDRESS = "kevin@distribute.you";
