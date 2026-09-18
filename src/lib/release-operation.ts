/**
 * The tag every message of ONE mailing-list release carries.
 *
 * Per release, never per list. It is what identifies exactly this release's
 * mail in the Postmark Activity archive, which is where a human goes to read
 * one message rather than an aggregate.
 *
 * It is NOT how the release's outcomes are read back. That question is keyed on
 * the release's own RUN, which the provider persists as each message's parent
 * run (see `release-health.ts`) — a tag turned out to be per-TEMPLATE in
 * storage rather than per-operation, so a tag-keyed aggregate answers for every
 * release that ever used the same template.
 */
export function releaseOperationId(releaseId: string): string {
  return `mailing-list-release-${releaseId}`;
}
