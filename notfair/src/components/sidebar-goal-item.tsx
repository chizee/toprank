"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Check,
  FolderKanban,
  FolderMinus,
  FolderPlus,
  MoreVertical,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  deleteGoalAction,
  pauseGoalAction,
  renameGoalAction,
  resumeGoalAction,
  setGoalPinnedAction,
} from "@/server/actions/goals";
import {
  createGoalGroupAction,
  moveGoalToGroupAction,
} from "@/server/actions/goal-groups";
import { GOAL_DRAG_TYPE } from "@/components/sidebar-goal-group";
import { GoalCompletionDialog } from "@/components/goal-completion-dialog";
import { cn } from "@/lib/utils";

type SidebarStatus = "intake" | "proposed" | "active" | "paused" | "achieved";

type CompletionSummary = {
  metricName: string | null;
  currentValue: number | null;
  targetValue: number | null;
  metricDirection: "increase" | "decrease" | null;
  completionReason: string | null;
  completedAt: string;
};

/**
 * One goal row in the sidebar rail: link to the goal screen plus a ⋮ menu
 * (pin, rename, move to group, pause/resume, delete). Rows are draggable onto
 * group headers. Server sidebar computes the label color; this component owns
 * the interactions.
 */
export function SidebarGoalItem({
  href,
  homeHref,
  goalId,
  label,
  status,
  pinned,
  labelClass,
  projectSlug,
  groups,
  groupId,
  needsAttention = false,
  completion,
}: {
  href: string;
  /** Project home — where the user lands after deleting the open goal. */
  homeHref: string;
  goalId: string;
  label: string;
  status: SidebarStatus;
  pinned: boolean;
  labelClass: string;
  projectSlug: string;
  /** Every group in the project — targets for "Move to group". */
  groups: { id: string; name: string }[];
  /** The group this goal currently belongs to, if any. */
  groupId: string | null;
  /** Open "Needs you" escalations — renders the amber attention mark. */
  needsAttention?: boolean;
  /** Achievement evidence for the celebration handoff. */
  completion?: CompletionSummary;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [draft, setDraft] = useState(label);
  const [groupDraft, setGroupDraft] = useState("");

  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    successMsg?: string,
    after?: () => void,
  ) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? "Action failed.");
        return;
      }
      if (successMsg) toast.success(successMsg);
      after?.();
      router.refresh();
    });
  }

  function onDelete() {
    run(
      () => deleteGoalAction(goalId),
      "Goal deleted.",
      () => {
        setDeleteOpen(false);
        // If the user is anywhere inside the deleted goal's screen, that
        // route is now a 404 — send them home.
        if (pathname === href || pathname?.startsWith(`${href}/`)) {
          router.push(homeHref);
        }
      },
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild>
        <Link
          href={href}
          className={cn(status === "achieved" && "pr-[7.4rem]!")}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(GOAL_DRAG_TYPE, goalId);
            e.dataTransfer.effectAllowed = "move";
          }}
        >
          <span className={cn("truncate", labelClass)}>{label}</span>
          {needsAttention && (
            <TriangleAlert
              aria-label="Needs your action"
              className="!size-3 shrink-0 text-[hsl(var(--notfair-warn))]"
            />
          )}
          {pinned && (
            <Pin
              aria-label="Pinned"
              className="ml-auto !size-3 shrink-0 text-[hsl(var(--notfair-ink-4))]"
            />
          )}
        </Link>
      </SidebarMenuButton>

      {status === "achieved" && completion && (
        <GoalCompletionDialog
          goalId={goalId}
          label={label}
          metricName={completion.metricName}
          currentValue={completion.currentValue}
          targetValue={completion.targetValue}
          metricDirection={completion.metricDirection}
          completionReason={completion.completionReason}
          completedAt={completion.completedAt}
          goalHref={href}
          trigger={
            <SidebarMenuAction
              data-completion-badge
              className="ns-completed-badge right-7 top-1 !h-6 !w-auto gap-1 rounded-full bg-[hsl(var(--notfair-accent-soft))] px-2 text-[10px] font-semibold text-[hsl(var(--notfair-accent))] shadow-[inset_0_0_0_1px_hsl(var(--notfair-accent-border))] hover:bg-[hsl(var(--notfair-accent-soft))] hover:text-[hsl(var(--notfair-accent))]"
              aria-label={`Celebrate completed goal: ${label}`}
            >
              <Sparkles className="!size-3" />
              <span>Completed</span>
            </SidebarMenuAction>
          }
        />
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label={`Goal actions: ${label}`}>
            <MoreVertical />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="min-w-44">
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              run(
                () => setGoalPinnedAction(goalId, !pinned),
                pinned ? "Unpinned." : "Pinned to top.",
              )
            }
          >
            {pinned ? <PinOff /> : <Pin />}
            {pinned ? "Unpin" : "Pin to top"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending}
            onSelect={() => {
              setDraft(label);
              setRenameOpen(true);
            }}
          >
            <Pencil />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={pending}>
              <FolderKanban />
              Move to group
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="min-w-44">
                {groups.map((group) => (
                  <DropdownMenuItem
                    key={group.id}
                    disabled={pending || group.id === groupId}
                    onSelect={() =>
                      run(
                        () => moveGoalToGroupAction(goalId, group.id),
                        `Moved to ${group.name}.`,
                      )
                    }
                  >
                    <span className="truncate">{group.name}</span>
                    {group.id === groupId && <Check className="ml-auto" />}
                  </DropdownMenuItem>
                ))}
                {groups.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  disabled={pending}
                  onSelect={() => {
                    setGroupDraft("");
                    setNewGroupOpen(true);
                  }}
                >
                  <FolderPlus />
                  New group…
                </DropdownMenuItem>
                {groupId && (
                  <DropdownMenuItem
                    disabled={pending}
                    onSelect={() =>
                      run(
                        () => moveGoalToGroupAction(goalId, null),
                        "Removed from group.",
                      )
                    }
                  >
                    <FolderMinus />
                    Remove from group
                  </DropdownMenuItem>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          {status === "active" && (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => run(() => pauseGoalAction(goalId), "Goal paused.")}
            >
              <Pause />
              Pause
            </DropdownMenuItem>
          )}
          {status === "paused" && (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() =>
                run(() => resumeGoalAction(goalId), "Goal resumed — heartbeat restarted.")
              }
            >
              <Play />
              Resume
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename goal</DialogTitle>
            <DialogDescription>
              Changes the display name everywhere — the ambition itself stays
              as you stated it.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => renameGoalAction(goalId, draft),
                "Goal renamed.",
                () => setRenameOpen(false),
              );
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              aria-label="Goal name"
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !draft.trim()}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{label}”?</DialogTitle>
            <DialogDescription>
              Permanently removes the goal, its agent, its chat history, and
              every check. There is no recovery — if you just want the loop to
              stop, close the goal from its page instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={onDelete} disabled={pending}>
              <Trash2 className="size-3.5" />
              Delete forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newGroupOpen} onOpenChange={setNewGroupOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New group with “{label}”</DialogTitle>
            <DialogDescription>
              A group is one dashboard for related goals. This goal becomes its
              first member — add more from any goal’s menu or by dragging.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () =>
                  createGoalGroupAction({
                    project_slug: projectSlug,
                    name: groupDraft,
                    goal_ids: [goalId],
                  }),
                "Group created.",
                () => setNewGroupOpen(false),
              );
            }}
          >
            <Input
              value={groupDraft}
              onChange={(e) => setGroupDraft(e.target.value)}
              placeholder="Ads MCP reliability"
              maxLength={80}
              autoFocus
              aria-label="Group name"
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setNewGroupOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !groupDraft.trim()}>
                Create group
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SidebarMenuItem>
  );
}
