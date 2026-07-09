"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreVertical, Pin, PinOff, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  deleteThreadAction,
  renameThreadAction,
  setThreadPinnedAction,
} from "@/server/actions/chat-threads";
import { cn } from "@/lib/utils";
import { projectHref } from "@/lib/project-href";

/**
 * Left rail for the agent chat page — mirrors the task workspace's rail:
 * a full-width "New chat" row on top, then a flat scrollable list of
 * threads. Rows are one line high; hovering a row slides overflowing
 * titles horizontally (marquee) to reveal the rest, and surfaces a ⋮
 * menu with Rename / Pin / Delete.
 */

export type SessionOriginLite =
  | { kind: "task"; display_id: string; title: string | null }
  | { kind: "cron"; cron_name: string }
  | { kind: "chat"; preview: string };

export type SessionLite = {
  sessionId: string;
  label: string;
  sessionKey: string;
  lastInteractionAt: number;
  pending: boolean;
  /** User-set display title (rename). Overrides the derived preview. */
  title?: string | null;
  /** True when pinned — the server sorts pinned threads first. */
  pinned?: boolean;
  /**
   * Server-classified origin. Drives the row title so users see a cron
   * name or first-message preview instead of a raw UUID. Undefined for
   * pending threads (no transcript yet).
   */
  origin?: SessionOriginLite;
};

function displayTitle(s: SessionLite): string {
  if (s.title) return s.title;
  if (s.pending) return "New thread";
  if (s.origin?.kind === "cron") return s.origin.cron_name;
  if (s.origin?.kind === "chat" && s.origin.preview) return s.origin.preview;
  if (s.label === "main") return "Main thread";
  return s.label;
}

/** Row shell shared by thread rows and the New chat button. */
const ROW_CLASS =
  "ns-thread-row group/row relative mx-2 block w-[calc(100%-1rem)] rounded-md px-2.5 py-2 text-left text-xs leading-4 transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:bg-sidebar-accent";

/**
 * Measure how far the row's title overflows its clip box and stash it as
 * a CSS var; the .ns-marquee hover rule animates the text by exactly that
 * distance. Runs on mouseenter so it always reflects current widths.
 */
function primeMarquee(e: React.MouseEvent<HTMLElement>) {
  const clip = e.currentTarget.querySelector<HTMLElement>(".ns-marquee");
  const text = clip?.firstElementChild as HTMLElement | null;
  if (!clip || !text) return;
  const overflow = Math.max(0, text.scrollWidth - clip.clientWidth);
  text.style.setProperty("--ns-marquee-shift", `-${overflow}px`);
  // Constant reading speed regardless of title length — a fixed duration
  // made long titles whip past.
  const PX_PER_SECOND = 25;
  text.style.setProperty(
    "--ns-marquee-duration",
    `${Math.max(1.5, overflow / PX_PER_SECOND)}s`,
  );
}

export function ChatThreadRail({
  projectSlug,
  agentSlug,
  sessions,
  activeSessionId,
}: {
  projectSlug: string;
  agentSlug: string;
  sessions: SessionLite[];
  activeSessionId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [renaming, setRenaming] = useState<SessionLite | null>(null);
  const [deleting, setDeleting] = useState<SessionLite | null>(null);

  // Task-kickoff threads belong to the Tasks tab (each task page shows
  // its own transcript) — listing them here would double-surface them.
  const visible = sessions.filter((s) => s.origin?.kind !== "task");

  function newThread() {
    const id = crypto.randomUUID();
    startTransition(() =>
      router.push(projectHref(projectSlug, `/agents/${agentSlug}/chat/${id}`)),
    );
  }

  function togglePin(s: SessionLite) {
    startTransition(async () => {
      const r = await setThreadPinnedAction({
        projectSlug,
        agentSlug,
        threadLabel: s.sessionId,
        pinned: !s.pinned,
      });
      if (!r.ok) toast.error(r.error);
      else router.refresh();
    });
  }

  function confirmDelete(s: SessionLite) {
    startTransition(async () => {
      const r = await deleteThreadAction({
        projectSlug,
        agentSlug,
        threadLabel: s.sessionId,
      });
      setDeleting(null);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Thread deleted.");
      if (s.sessionId === activeSessionId) {
        // The open thread just vanished — move to a fresh one.
        newThread();
      } else {
        router.refresh();
      }
    });
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col bg-[hsl(var(--notfair-sidebar))]">
      <div className="pt-2">
        {/* Same shell as a thread row so the rail reads as one list. */}
        <button
          type="button"
          onClick={newThread}
          disabled={pending}
          className={cn(ROW_CLASS, "disabled:opacity-50")}
        >
          <span className="inline-flex items-center gap-1.5 font-medium text-muted-foreground group-hover/row:text-foreground">
            <Plus className="size-3.5" />
            New chat
          </span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {visible.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No threads yet — say hi below.
          </div>
        ) : (
          /* gap-1 matches SidebarMenu's item spacing, same as the task rail. */
          <ul className="flex flex-col gap-1">
            {visible.map((s) => {
              const isActive = s.sessionId === activeSessionId;
              return (
                <li key={s.sessionId} className="relative">
                  <Link
                    href={projectHref(
                      projectSlug,
                      `/agents/${agentSlug}/chat/${s.sessionId}`,
                    )}
                    aria-current={isActive ? "true" : undefined}
                    onMouseEnter={primeMarquee}
                    className={cn(
                      ROW_CLASS,
                      // Reserve space for the ⋮ button (and pin glyph).
                      "pr-8",
                      isActive && "bg-sidebar-accent",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      {s.pinned && (
                        <Pin
                          aria-label="Pinned"
                          className="size-3 shrink-0 text-muted-foreground"
                        />
                      )}
                      <span className="ns-marquee min-w-0 flex-1">
                        <span
                          className={cn(
                            isActive
                              ? "font-medium text-foreground"
                              : "text-foreground/90",
                          )}
                        >
                          {displayTitle(s)}
                        </span>
                      </span>
                    </span>
                  </Link>
                  {/* ⋮ menu — a sibling of the Link (not a child: nested
                      interactive elements are invalid HTML), absolutely
                      positioned into the row's reserved right padding. */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Thread actions for ${displayTitle(s)}`}
                        className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:opacity-100 [li:hover_&]:opacity-100"
                      >
                        <MoreVertical className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" side="right">
                      <DropdownMenuItem onSelect={() => setRenaming(s)}>
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => togglePin(s)}>
                        {s.pinned ? (
                          <>
                            <PinOff className="mr-1.5 size-3.5" /> Unpin
                          </>
                        ) : (
                          <>
                            <Pin className="mr-1.5 size-3.5" /> Pin
                          </>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeleting(s)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {renaming && (
        <RenameThreadDialog
          session={renaming}
          onClose={() => setRenaming(null)}
          onSubmit={(title) => {
            const target = renaming;
            startTransition(async () => {
              const r = await renameThreadAction({
                projectSlug,
                agentSlug,
                threadLabel: target.sessionId,
                title,
              });
              setRenaming(null);
              if (!r.ok) toast.error(r.error);
              else router.refresh();
            });
          }}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete thread?</DialogTitle>
            <DialogDescription>
              This permanently deletes the conversation
              {deleting ? ` "${displayTitle(deleting)}"` : ""} and its
              transcript. There is no undo.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() => deleting && confirmDelete(deleting)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function RenameThreadDialog({
  session,
  onClose,
  onSubmit,
}: {
  session: SessionLite;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  const [value, setValue] = useState(session.title ?? "");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
          <DialogDescription>
            Leave empty to go back to the automatic title.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(value.trim());
          }}
        >
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={displayTitle({ ...session, title: null })}
            aria-label="Thread title"
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
