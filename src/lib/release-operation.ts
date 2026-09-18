/**
 * The handle every message of ONE mailing-list release carries.
 *
 * Per release, never per list. It is written onto each message at send time
 * and read back by the health probe to ask the provider how that release
 * landed, so both sides must derive it the same way: a handle written one way
 * and read another is a self-halt that never fires.
 *
 * It lives in its own module on purpose. The worker's tests mock the health
 * probe wholesale, so a helper exported from there would come back undefined
 * inside the send path and every message would go out untagged — silently,
 * because each send is caught per address.
 */
export function releaseOperationId(releaseId: string): string {
  return `mailing-list-release-${releaseId}`;
}
