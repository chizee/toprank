"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ChatComposer, type ModelOption } from "@/components/chat/composer";
import { LiveWorkingIndicator } from "@/components/chat/live-working-indicator";
import {
  AssistantText,
  BlockedStatus,
  ErrorRow,
  RenderItem,
  ToolGroup,
  TranscriptEmptyState,
  UserBubble,
} from "@/components/chat/messages";
import { collapseEvents } from "@/components/chat/transcript-model";
import { useChatStream } from "@/components/chat/use-chat-stream";
import type { McpCatalogEntryLite } from "@/components/chat/tool-intent";
import {
  executeLocalSlashCommand,
  parseSlashMessage,
} from "@/lib/slash-commands";
import type { TranscriptEvent } from "@/server/sessions/transcript-tail";

export type { McpCatalogEntryLite };

type Props = {
  projectSlug: string;
  agentSlug: string;
  agentDisplayName: string;
  /** Thread label (the URL half of the (agent, label) session key). */
  threadId: string;
  /** Server-rendered initial slice of the transcript. */
  initialEvents: TranscriptEvent[];
  /** Byte offset *after* `initialEvents` — polls start from here. */
  initialCursor: number;
  /**
   * When true, disables the composer. This does not imply that a turn is
   * still running; read-only transcript views also disable the composer.
   */
  composerDisabled?: boolean;
  /**
   * Optional explanation shown inside a disabled composer. Read-only
   * transcript views use this instead of claiming the agent is working.
   */
  disabledComposerPlaceholder?: string;
  /** Keep a static terminal status visible in read-only transcript views. */
  showCompletedStatus?: boolean;
  /**
   * Set when the agent's task is parked in `blocked` (e.g., waiting on a
   * pending approval). Replaces the "thinking…" indicator — that implies
   * forward motion, but a blocked task is dormant by design.
   */
  blockedReason?: string;
  /**
   * MCP servers known to this project — used to render brand favicons
   * next to MCP tool calls. Optional; omitted = generic tool icons.
   */
  mcpCatalog?: McpCatalogEntryLite[];
  /**
   * Rendered at the very top of the scrollable log, above the first
   * event — scrolling the history to the top reveals it.
   */
  leadingContent?: React.ReactNode;
  /**
   * Models the composer's selector offers for this project's harness.
   * The option marked `is_default` names the model used when no override
   * flag is sent. Omitted/empty = no selector rendered.
   */
  modelOptions?: ModelOption[];
};

/**
 * THE chat surface: committed transcript + live streaming turn + composer.
 * This component is a thin orchestrator — the streaming state machine
 * lives in `chat/use-chat-stream`, the message rendering in
 * `chat/messages`, the composer in `chat/composer`, and every pure
 * derivation in `chat/transcript-model` / `chat/tool-intent` /
 * `chat/working-view`.
 */
export function LiveTranscript({
  projectSlug,
  agentSlug,
  agentDisplayName,
  threadId,
  initialEvents,
  initialCursor,
  composerDisabled = false,
  disabledComposerPlaceholder,
  showCompletedStatus = false,
  blockedReason,
  mcpCatalog,
  leadingContent,
  modelOptions = [],
}: Props) {
  // Composer model override. "" = harness default (no flag). Persisted
  // per project+agent in localStorage; loaded after mount so SSR and the
  // first client render agree (no hydration mismatch).
  const modelStorageKey = `NotFair:model:${projectSlug}:${agentSlug}`;
  const [model, setModel] = useState("");
  useEffect(() => {
    const stored = window.localStorage.getItem(modelStorageKey);
    if (stored && modelOptions.some((m) => m.value === stored)) {
      setModel(stored);
    }
    // modelOptions is a fresh array per render from the server page —
    // key its identity by content to avoid effect churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelStorageKey, JSON.stringify(modelOptions)]);
  function onPickModel(value: string) {
    setModel(value);
    if (value) window.localStorage.setItem(modelStorageKey, value);
    else window.localStorage.removeItem(modelStorageKey);
  }
  const defaultModelLabel =
    modelOptions.find((option) => option.is_default)?.label ?? "Default";
  const selectedModelLabel =
    modelOptions.find((option) => option.value === model)?.label ??
    defaultModelLabel;

  const stream = useChatStream({
    projectSlug,
    agentSlug,
    threadId,
    initialEvents,
    initialCursor,
    model,
  });
  const {
    events,
    sendingChat,
    remoteTurnActive,
    openTurn,
    turnStartedAt,
    pendingUserMsg,
    pendingAssistant,
    pendingTools,
    pendingError,
    pendingLifecycle,
  } = stream;
  const composerBusy = sendingChat || remoteTurnActive;

  // ── Submit routing: local slash commands intercept before the wire. ──
  async function onSubmit(text: string) {
    const parsed = parseSlashMessage(text);
    if (parsed) {
      const action = executeLocalSlashCommand(parsed.command, parsed.args);
      if (action) {
        switch (action.kind) {
          case "clear":
            stream.clearLocal();
            toast.info(
              "Local view cleared. Full transcript is still on disk; the next agent reply will repopulate.",
            );
            return;
          case "stop":
            stream.stopTurn();
            return;
          case "set-model": {
            const wanted = action.value.toLowerCase();
            const names = [
              `${defaultModelLabel} (default)`,
              ...modelOptions.map((m) => m.label),
            ].join(", ");
            if (!wanted) {
              toast.message("Model", {
                description: `Current: ${selectedModelLabel}. Options: ${names}.`,
              });
              return;
            }
            if (wanted === "default") {
              onPickModel("");
              toast.success(`Model reset to ${defaultModelLabel}.`);
              return;
            }
            const match = modelOptions.find(
              (m) =>
                m.value.toLowerCase() === wanted ||
                m.label.toLowerCase() === wanted,
            );
            if (!match) {
              toast.error(`Unknown model '${action.value}'. Options: ${names}.`);
              return;
            }
            onPickModel(match.value);
            toast.success(`Model set to ${match.label}.`);
            return;
          }
          case "help":
            toast.message("Slash commands", { description: action.content });
            return;
        }
      }
    }
    const result = await stream.send(text);
    if (result?.error) toast.error(result.error);
  }

  // ── Auto-scroll: only when the user is already near the bottom. ─────
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyBottomRef = useRef(true);
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickyBottomRef.current = remaining < 96;
  }
  useLayoutEffect(() => {
    if (!stickyBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, sendingChat, pendingAssistant, pendingTools, pendingUserMsg]);

  const rendered = useMemo(() => collapseEvents(events), [events]);
  const transcriptEnded = events.some(
    (e) => e.kind === "lifecycle" && e.phase === "done",
  );
  // Keep the indicator at the bottom of the transcript throughout a live
  // turn. Read-only logs can opt into a static completed status, but merely
  // disabling the composer must never manufacture a forever-running state.
  const showThinking =
    sendingChat ||
    remoteTurnActive ||
    Boolean(blockedReason) ||
    (showCompletedStatus && transcriptEnded);

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
        role="log"
        aria-live="polite"
      >
        <div className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-6">
          {leadingContent}
          {rendered.length === 0 &&
          !pendingUserMsg &&
          !sendingChat &&
          !composerDisabled &&
          !blockedReason ? (
            <TranscriptEmptyState agentDisplayName={agentDisplayName} />
          ) : (
            <ol className="m-0 list-none space-y-6 p-0">
              {rendered.map((item) => (
                <li key={item.key}>
                  <RenderItem item={item} mcpCatalog={mcpCatalog} />
                </li>
              ))}
              {pendingUserMsg && (
                <li>
                  <UserBubble body={pendingUserMsg} />
                </li>
              )}
              {pendingTools.length > 0 && (
                <li>
                  <ToolGroup tools={pendingTools} mcpCatalog={mcpCatalog} />
                </li>
              )}
              {pendingAssistant && (
                <li>
                  <AssistantText body={pendingAssistant} streaming />
                </li>
              )}
              {pendingError && (
                <li>
                  <ErrorRow
                    agentDisplayName={agentDisplayName}
                    body={pendingError}
                  />
                </li>
              )}
              {showThinking && (
                <li>
                  {blockedReason ? (
                    <BlockedStatus reason={blockedReason} />
                  ) : (
                    <LiveWorkingIndicator
                      agentDisplayName={agentDisplayName}
                      events={events}
                      turnStartedAt={turnStartedAt ?? openTurn?.startedAt ?? null}
                      lifecyclePhase={pendingLifecycle}
                      pendingTools={pendingTools}
                      hasPendingAssistant={pendingAssistant.length > 0}
                    />
                  )}
                </li>
              )}
            </ol>
          )}
        </div>
      </div>

      <div className="bg-gradient-to-t from-background via-background/95 to-transparent pt-2">
        <div className="mx-auto w-full max-w-3xl px-5 pb-3 sm:px-6">
          <ChatComposer
            disabled={composerDisabled}
            busy={composerBusy}
            sendingChat={sendingChat}
            placeholder={
              composerDisabled
                ? disabledComposerPlaceholder ??
                  "The agent is working — the transcript updates live"
                : blockedReason
                  ? "Reply — the agent will see your message"
                  : "Message this goal's agent…  (type / for commands)"
            }
            modelOptions={modelOptions}
            model={model}
            onPickModel={onPickModel}
            onSubmit={(text) => void onSubmit(text)}
            onStop={stream.stopTurn}
          />
        </div>
      </div>
    </div>
  );
}
