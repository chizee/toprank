"use client";

import { Badge } from "@/components/ui/badge";
import { useApprovalsBadge } from "./live-counts-context";

/**
 * Live-updating approvals count badge. Reads from LiveCountsContext so
 * the number refreshes without re-rendering the parent server component.
 */
export function ApprovalsLiveBadge() {
  const count = useApprovalsBadge();
  if (count <= 0) return null;
  return (
    <Badge variant="secondary" className="ml-auto h-5 px-1.5 text-[10px]">
      {count}
    </Badge>
  );
}
