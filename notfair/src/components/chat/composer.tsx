"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, StopCircle } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RunningDot } from "@/components/running-dot";
import { SlashCommandPopover } from "@/components/slash-command-popover";
import {
  filterSlashCommands,
  type SlashCommand,
} from "@/lib/slash-commands";

export type ModelOption = {
  value: string;
  label: string;
  is_default?: boolean;
  reasoning_efforts?: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
  default_reasoning_effort?: string;
};

/**
 * The chat composer: one floating rounded well with a borderless
 * multiline textarea, slash-command autocomplete, a quiet model picker,
 * and the circular send/stop control. Owns its input + slash state;
 * everything that changes the conversation goes through `onSubmit` /
 * `onStop`. The busy affordances mirror the app-grade chat pattern:
 * while ANY turn is live (local send or a remote turn detected from the
 * transcript), send flips to stop and the footer says so.
 */
export function ChatComposer({
  disabled = false,
  busy,
  sendingChat,
  placeholder,
  modelOptions = [],
  model,
  reasoningEffort,
  onPickModel,
  onPickReasoningEffort,
  onSubmit,
  onStop,
}: {
  disabled?: boolean;
  /** Any live turn — local send or detected remote turn. */
  busy: boolean;
  /** This tab's own streaming send (subset of busy). */
  sendingChat: boolean;
  placeholder: string;
  modelOptions?: ModelOption[];
  model: string;
  reasoningEffort: string;
  onPickModel: (value: string) => void;
  onPickReasoningEffort: (value: string) => void;
  /** Dispatch a user submission (slash routing happens upstream). */
  onSubmit: (text: string) => void;
  onStop: () => void;
}) {
  const [input, setInput] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const defaultModel = modelOptions.find((option) => option.is_default);
  const selectedModel =
    modelOptions.find((option) => option.value === model) ?? defaultModel;
  const selectedModelLabel = selectedModel?.label ?? "Default";
  const effortOptions = selectedModel?.reasoning_efforts ?? [];
  const defaultEffort =
    selectedModel?.default_reasoning_effort ?? effortOptions[0]?.value;
  const selectedEffort =
    effortOptions.find((option) => option.value === reasoningEffort) ??
    effortOptions.find((option) => option.value === defaultEffort) ??
    effortOptions[0];

  // Slash command autocomplete: open while input starts with "/" and the
  // user is still composing the command name (no space yet). After they
  // pick or type a space, the popover closes.
  const slashQuery =
    input.startsWith("/") && !input.includes(" ") ? input : null;
  const slashOpen = slashQuery !== null && !sendingChat && !disabled;
  const slashMatches = useMemo<SlashCommand[]>(
    () => (slashOpen ? filterSlashCommands(slashQuery!) : []),
    [slashOpen, slashQuery],
  );
  const safeSlashIndex =
    slashMatches.length === 0 ? 0 : Math.min(slashIndex, slashMatches.length - 1);

  function insertSlashCommand(cmd: SlashCommand) {
    // Catalog `name` is the command without the leading slash ("new",
    // "clear"). Insert ends with a trailing space so the popover closes —
    // a second Enter then submits.
    const insert = cmd.insert ?? `/${cmd.name} `;
    setInput(insert);
    setSlashIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(insert.length, insert.length);
      }
    });
  }

  // Multiline auto-grow: track the content height (capped by max-h-52 via
  // CSS) so the composer expands as the user types and snaps back when
  // the input clears.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [input]);

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setSlashIndex(0);
    onSubmit(text);
  }

  return (
    <div className="relative">
      {slashOpen && (
        <SlashCommandPopover
          commands={slashMatches}
          selectedIndex={safeSlashIndex}
          onSelect={insertSlashCommand}
          onHover={setSlashIndex}
        />
      )}
      <form
        className="rounded-[24px] bg-card shadow-[var(--notfair-shadow)] ring-1 ring-transparent transition-shadow focus-within:shadow-[var(--notfair-shadow-lg,var(--notfair-shadow))] focus-within:ring-foreground/10"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setSlashIndex(0);
          }}
          onKeyDown={(e) => {
            // Slash autocomplete: arrow keys cycle, Tab/Enter insert.
            if (slashOpen && slashMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((i) => (i + 1) % slashMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex(
                  (i) => (i - 1 + slashMatches.length) % slashMatches.length,
                );
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                const picked = slashMatches[safeSlashIndex];
                if (picked) insertSlashCommand(picked);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setInput("");
                setSlashIndex(0);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          className="block max-h-52 w-full resize-none bg-transparent px-4.5 pt-3.5 text-sm leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="flex items-center justify-end gap-1.5 px-2.5 pb-2.5 pt-1.5">
          {/* Model picker sits right next to the send button: quiet
              "<model> ⌄" text trigger, dropdown opening above. */}
          {modelOptions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Model and effort"
                  disabled={disabled || sendingChat}
                  className="inline-flex max-w-44 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="truncate">
                    {selectedModelLabel}
                    {selectedEffort ? ` · ${selectedEffort.label}` : ""}
                  </span>
                  <ChevronDown className="size-3 shrink-0" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top">
                <DropdownMenuLabel>Model</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={model} onValueChange={onPickModel}>
                  {!defaultModel && (
                    <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>
                  )}
                  {modelOptions.map((m) => (
                    <DropdownMenuRadioItem
                      key={m.value}
                      value={m.is_default ? "" : m.value}
                    >
                      {m.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {effortOptions.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={reasoningEffort}
                      onValueChange={onPickReasoningEffort}
                    >
                      {effortOptions.map((option) => (
                        <DropdownMenuRadioItem
                          key={option.value}
                          value={option.value === defaultEffort ? "" : option.value}
                          title={option.description}
                        >
                          {option.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              className="flex size-9 items-center justify-center rounded-full bg-[hsl(var(--notfair-surface-2))] text-foreground transition-colors hover:bg-[hsl(var(--notfair-hover))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <StopCircle className="size-4.5" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={disabled || !input.trim()}
              aria-label="Send"
              className="flex size-9 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85 disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowUp className="size-4.5" />
            </button>
          )}
        </div>
      </form>
      {(busy || !disabled) && (
        <p className="pt-1.5 text-center text-[10px] text-muted-foreground">
          {busy ? (
            <span className="inline-flex items-center gap-1.5">
              <RunningDot size="sm" aria-label="" />
              {sendingChat
                ? "Streaming — click stop to abort"
                : "Agent is working — click stop to interrupt"}
            </span>
          ) : (
            <>Enter to send · Shift+Enter for newline</>
          )}
        </p>
      )}
    </div>
  );
}
