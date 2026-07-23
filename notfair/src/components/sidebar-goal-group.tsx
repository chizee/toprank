"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type DragEvent } from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  CircleCheck,
  LayoutDashboard,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  deleteGoalGroupAction,
  moveGoalToGroupAction,
  renameGoalGroupAction,
} from "@/server/actions/goal-groups";
import { cn } from "@/lib/utils";

/** DataTransfer MIME type carrying a goal id during a rail drag. */
export const GOAL_DRAG_TYPE = "application/x-notfair-goal";

/**
 * One goal group in the sidebar rail: a goal-style collapsible row with its
 * member goals nested beneath, a ⋮ menu (dashboard, rename, delete), and a
 * drop target for goal rows dragged from the rail.
 */
export function SidebarGoalGroup({
  groupId,
  name,
  href,
  completedCount = 0,
  children,
}: {
  groupId: string;
  name: string;
  /** Group dashboard route. */
  href: string;
  /** Unarchived achievements inside a collapsed group remain discoverable. */
  completedCount?: number;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [collapsed, setCollapsed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [draft, setDraft] = useState(name);

  // Collapse state survives navigation via localStorage; read after mount so
  // the server-rendered (expanded) markup hydrates cleanly.
  const storageKey = `notfair.rail.group.${groupId}.collapsed`;
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(storageKey) === "1");
  }, [storageKey]);

  function persistCollapsed(next: boolean) {
    setCollapsed(next);
    if (next) window.localStorage.setItem(storageKey, "1");
    else window.localStorage.removeItem(storageKey);
  }

  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    successMsg: string,
    after?: () => void,
  ) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? "Action failed.");
        return;
      }
      toast.success(successMsg);
      after?.();
      router.refresh();
    });
  }

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes(GOAL_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  }

  function onDrop(e: DragEvent) {
    setDragOver(false);
    const goalId = e.dataTransfer.getData(GOAL_DRAG_TYPE);
    if (!goalId) return;
    e.preventDefault();
    run(
      () => moveGoalToGroupAction(goalId, groupId),
      `Moved to ${name}.`,
      // Expand so the user sees the goal land.
      () => persistCollapsed(false),
    );
  }

  return (
    <SidebarMenuItem
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <SidebarMenuButton
        onClick={() => persistCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        className={cn(
          dragOver && "bg-sidebar-accent ring-2 ring-sidebar-ring",
        )}
      >
        <span className="truncate">{name}</span>
        {completedCount > 0 && (
          <span
            aria-label={`${completedCount} completed goal${completedCount === 1 ? "" : "s"}`}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[hsl(var(--notfair-accent-soft))] px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-[hsl(var(--notfair-accent))]"
          >
            <CircleCheck className="!size-3" />
            {completedCount}
          </span>
        )}
        <ChevronRight
          data-group-chevron
          aria-hidden
          className={cn(
            "!size-3.5 shrink-0 text-[hsl(var(--notfair-ink-4))] transition-transform",
            !collapsed && "rotate-90",
          )}
        />
      </SidebarMenuButton>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label={`Group actions: ${name}`}>
            <MoreVertical />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="min-w-44">
          <DropdownMenuItem asChild>
            <Link href={href}>
              <LayoutDashboard />
              Open dashboard
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending}
            onSelect={() => {
              setDraft(name);
              setRenameOpen(true);
            }}
          >
            <Pencil />
            Rename…
          </DropdownMenuItem>
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

      {/* Members stay mounted while collapsed so their dialog state survives. */}
      <SidebarMenuSub className="mr-0 pr-0" hidden={collapsed}>
        {children}
      </SidebarMenuSub>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename group</DialogTitle>
            <DialogDescription>
              Changes the display name everywhere — the goals inside are
              untouched.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => renameGoalGroupAction(groupId, draft),
                "Group renamed.",
                () => setRenameOpen(false),
              );
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              aria-label="Group name"
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
            <DialogTitle>Delete “{name}”?</DialogTitle>
            <DialogDescription>
              Removes the group and its dashboard. Its goals become ungrouped —
              their heartbeats and history are untouched.
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
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                run(
                  () => deleteGoalGroupAction(groupId),
                  "Group deleted. Its goals are now ungrouped.",
                  () => setDeleteOpen(false),
                )
              }
            >
              <Trash2 className="size-3.5" />
              Delete group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarMenuItem>
  );
}
