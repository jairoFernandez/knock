// Pure rules for the About → Stargazers tab, kept DOM-free for unit tests.

/**
 * A cached list is only reusable while it still matches the live star count.
 * The count comes from an endpoint that works anonymously; the list does not,
 * so a cache from before a new star would otherwise be shown as complete.
 */
export function isCacheUsable(cachedLength: number, total: number | null): boolean {
  if (cachedLength === 0) return false;
  return total === null || cachedLength === total;
}

/**
 * Note shown above the grid when it is not the full, current list, or null
 * when it is.
 */
export function stargazerNotice(state: {
  listed: number;
  total: number | null;
  stale: boolean;
}): string | null {
  const { listed, total, stale } = state;
  const partial = total !== null && listed < total;
  if (!stale && !partial) return null;
  const count = total !== null ? `Showing ${listed} of ${total}` : `Showing ${listed}`;
  return stale
    ? `${count} from a saved copy — GitHub now requires sign-in to list stargazers.`
    : `${count}.`;
}
