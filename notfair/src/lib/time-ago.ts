/** Compact relative timestamp: "42s ago", "5m ago", "3h ago", "2d ago". */
export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Compact future counterpart: "in 42s", "in 5m", "in 3h", "in 2d".
 *  A timestamp already in the past reads "now" — the state flips on the
 *  next refresh, so don't pretend there's time left. */
export function timeUntil(iso: string, now = Date.now()): string {
  const seconds = (new Date(iso).getTime() - now) / 1000;
  if (seconds <= 0) return "now";
  if (seconds < 60) return `in ${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `in ${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.ceil(seconds / 3600)}h`;
  return `in ${Math.ceil(seconds / 86400)}d`;
}
