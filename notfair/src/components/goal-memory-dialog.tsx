"use client";

import { useState } from "react";
import { Brain } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";

export type MemoryEntry = {
  id: string;
  body: string;
  confidence: "low" | "medium" | "high";
  created_at: string;
};

const CONFIDENCE_STYLE: Record<MemoryEntry["confidence"], string> = {
  high: "text-[hsl(var(--notfair-accent))]",
  medium: "text-[hsl(var(--notfair-ink-3))]",
  low: "text-[hsl(var(--notfair-ink-4))]",
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * The goal's memory, one click from the header: everything the agent has
 * learned about this goal (the `log_learning` ledger), newest first, with
 * confidence and date. Lives in the header so it's reachable without
 * scrolling the rail, and scales past the handful a rail section could fit.
 */
export function GoalMemoryDialog({ entries }: { entries: MemoryEntry[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="ns-chip"
          title="What the agent has learned about this goal"
        >
          <Brain className="size-3.5" aria-hidden />
          Memory
          <span className="tabular-nums text-[hsl(var(--notfair-ink-4))]">
            {entries.length}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[70vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Brain className="size-4" aria-hidden />
            Memory
          </DialogTitle>
          <DialogDescription>
            What the agent has learned working this goal — it reads these
            before every check.
          </DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {entries.map((l) => (
            <li
              key={l.id}
              className="rounded-md bg-[hsl(var(--notfair-surface-2)/0.5)] px-3 py-2.5 text-[13px] leading-snug"
            >
              <Markdown className="text-[13px] text-[hsl(var(--notfair-ink-2))]">{l.body}</Markdown>
              <p className="m-0 mt-1 text-[11px] text-[hsl(var(--notfair-ink-4))]">
                <span className={cn("font-medium", CONFIDENCE_STYLE[l.confidence])}>
                  {l.confidence} confidence
                </span>{" "}
                · {fmtDate(l.created_at)}
              </p>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
