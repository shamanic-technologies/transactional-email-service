/**
 * email-gateway answered 504 `send_outcome_unknown`: its call to the provider
 * timed out or dropped after the request left, so the message may have gone
 * out (SIGNUP-EMAILS-1111: the welcome to info@zenotris.com was delivered twice
 * while our row said failed). A caller never re-sends on this error.
 *
 * Own module: tests `vi.mock` email-gateway.js whole, and an error class
 * exported from there comes back undefined in the code that checks for it.
 */
export const SEND_OUTCOME_UNKNOWN = "send_outcome_unknown";

export class SendOutcomeUnknownError extends Error {
  readonly code = SEND_OUTCOME_UNKNOWN;
  constructor(message: string) {
    super(message);
    this.name = "SendOutcomeUnknownError";
  }
}

export function isSendOutcomeUnknown(err: unknown): boolean {
  return err instanceof SendOutcomeUnknownError || (err as { code?: unknown } | null)?.code === SEND_OUTCOME_UNKNOWN;
}

/** The error a non-2xx gateway answer becomes: unknown outcome when the gateway says so. */
export function gatewaySendError(status: number, body: unknown): Error {
  const message = `Email sending failed (${status}): ${JSON.stringify(body)}`;
  if (status === 504 && (body as { code?: unknown } | null)?.code === SEND_OUTCOME_UNKNOWN) {
    return new SendOutcomeUnknownError(message);
  }
  return new Error(message);
}
