"use client";

import { useState } from "react";
import { Activity } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { GoalMoves, type MoveRow } from "@/components/goal-moves";

/**
 * The goal's moves journal, one click from the header. Everything inside
 * is work the agent ALREADY did — the framing exists to kill the
 * "is this a to-do list?" misread. Hidden while there are no open moves.
 */
export function GoalMovesDialog({
  moves,
  nextCheckAt,
}: {
  moves: MoveRow[];
  nextCheckAt: string | null;
}) {
  const [open, setOpen] = useState(false);
  if (moves.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="ns-chip"
          title="Moves the agent has made that aren't scored yet"
        >
          <Activity className="size-3.5" aria-hidden />
          Moves
          <span className="tabular-nums text-[hsl(var(--notfair-ink-4))]">
            {moves.length}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[75vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Activity className="size-4" aria-hidden />
            Moves
          </DialogTitle>
          <DialogDescription>
            Nothing here is a to-do — every move is already done, logged the
            moment the agent acted. A move&rsquo;s effect is observed for a
            while, then its outcome gets scored at a later check.
          </DialogDescription>
        </DialogHeader>
        <GoalMoves moves={moves} nextCheckAt={nextCheckAt} />
      </DialogContent>
    </Dialog>
  );
}
