"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { SlashCommand } from "@/lib/slash-commands";

type Props = {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
};

const CATEGORY_LABEL: Record<SlashCommand["category"], string> = {
  session: "Session",
  model: "Model",
  status: "Status",
};

const CATEGORY_ACCENT: Record<SlashCommand["category"], string> = {
  session: "text-[hsl(var(--notfair-ink-4))]",
  model: "text-[hsl(var(--notfair-ink-4))]",
  status: "text-[hsl(var(--notfair-ink-4))]",
};

export function SlashCommandPopover({
  commands,
  selectedIndex,
  onSelect,
  onHover,
}: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the selected row in view as the user arrows through a long list.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.children[selectedIndex] as HTMLElement | undefined;
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) {
    return (
      <div
        className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border bg-popover p-3 text-xs text-muted-foreground shadow-lg"
        role="listbox"
        aria-label="Slash commands"
      >
        No matching slash commands.
      </div>
    );
  }

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border bg-popover shadow-lg"
      role="listbox"
      aria-label="Slash commands"
    >
      <ul ref={listRef} className="max-h-72 overflow-y-auto py-1">
        {commands.map((c, idx) => {
          const isActive = idx === selectedIndex;
          return (
            <li key={c.name}>
              <button
                type="button"
                onMouseEnter={() => onHover(idx)}
                onClick={() => onSelect(c)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                  isActive ? "bg-accent" : "hover:bg-accent/50",
                )}
                role="option"
                aria-selected={isActive}
              >
                <span className="w-28 shrink-0 font-mono text-[13px] text-foreground">
                  /{c.name}
                  {c.args && (
                    <span className="ml-1 text-muted-foreground">{c.args}</span>
                  )}
                </span>
                <span className="flex-1 truncate text-xs text-muted-foreground">
                  {c.description}
                </span>
                {c.executeLocal && (
                  <span className="shrink-0 rounded border px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                    local
                  </span>
                )}
                <span
                  className={cn(
                    "shrink-0 text-[10px] uppercase tracking-wide",
                    CATEGORY_ACCENT[c.category],
                  )}
                >
                  {CATEGORY_LABEL[c.category]}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
        ↑↓ navigate · Enter / Tab to select · Enter again to send · Esc to clear
      </div>
    </div>
  );
}
