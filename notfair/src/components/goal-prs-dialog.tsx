"use client";

import { useState } from "react";
import { GitPullRequest } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { timeAgo } from "@/lib/time-ago";

/** Plain-JSON PR row for the dialog (subset of the goal_prs table). */
export type PrRow = {
  id: string;
  url: string;
  title: string;
  state: "open" | "merged" | "closed";
  review_decision: string | null;
  comment_count: number;
  is_draft: boolean;
  branch: string | null;
  created_at: string;
  sync_error: string | null;
};

/**
 * The goal's open pull requests, one click from the header — count on the
 * button like Memory, full list with review state in the modal. Merged and
 * closed PRs stay reachable from the check that produced them; this is the
 * "what's waiting on a human" view. Hidden while nothing is open.
 */
export function GoalPrsDialog({ prs }: { prs: PrRow[] }) {
  const [open, setOpen] = useState(false);
  if (prs.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[hsl(var(--notfair-surface-2))] px-2.5 py-1 text-[12px] text-[hsl(var(--notfair-ink-3))] transition-colors hover:text-[hsl(var(--notfair-ink-1))]"
          title="Open pull requests this goal's agent is waiting on"
        >
          <GitPullRequest className="size-3.5" aria-hidden />
          PRs
          <span className="tabular-nums text-[hsl(var(--notfair-ink-4))]">
            {prs.length}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[70vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <GitPullRequest className="size-4" aria-hidden />
            Open pull requests
          </DialogTitle>
          <DialogDescription>
            Submissions awaiting review — the agent reacts to each PR&rsquo;s
            state on every check.
          </DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {prs.map((pr) => (
            <PrItem key={pr.id} pr={pr} />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function PrItem({ pr }: { pr: PrRow }) {
  return (
    <li className="rounded-md bg-[hsl(var(--notfair-surface-2)/0.5)] px-3 py-2.5 text-[12.5px] leading-snug">
      <div className="flex items-baseline justify-between gap-2">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="ns-link min-w-0 truncate font-medium"
        >
          {pr.title}
        </a>
        <span className="shrink-0 text-[10.5px] tabular-nums text-[hsl(var(--notfair-ink-4))]">
          {timeAgo(pr.created_at)}
        </span>
      </div>
      <p className="m-0 mt-1 flex flex-wrap items-center gap-1.5">
        {pr.state === "merged" ? (
          <span className="ns-tag">merged</span>
        ) : pr.state === "closed" ? (
          <span className="ns-tag-red">closed unmerged</span>
        ) : pr.is_draft ? (
          <span className="ns-tag">draft</span>
        ) : pr.review_decision === "CHANGES_REQUESTED" ? (
          <span className="ns-tag-amber">changes requested — agent&rsquo;s turn</span>
        ) : (
          <span className="ns-tag-accent">needs your review</span>
        )}
        {pr.comment_count > 0 && (
          <span className="text-[11px] text-[hsl(var(--notfair-ink-4))]">
            {pr.comment_count} comment{pr.comment_count === 1 ? "" : "s"}
          </span>
        )}
        {pr.branch && <span className="ns-tag-mono">{pr.branch}</span>}
      </p>
      {pr.sync_error && (
        <p className="m-0 mt-0.5 text-[11px] text-[hsl(var(--notfair-warn))]">
          sync failed: {pr.sync_error}
        </p>
      )}
    </li>
  );
}
