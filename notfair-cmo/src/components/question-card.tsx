"use client";

import { useState, useTransition } from "react";
import { MessageSquareQuote } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  answerQuestionAction,
  cancelQuestionAction,
} from "@/server/actions/questions";
import type { Question } from "@/types";

function timeAgo(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export type QuestionCardProps = {
  question: Question;
  /** Options parsed from question.options_json. Empty array = free-text only. */
  options: string[];
};

/**
 * Renders an open `ask_user_question` row as a structured card above the
 * task transcript. The user can pick one of the agent-provided options
 * AND/OR type a free-text answer. Submit fires answerQuestionAction,
 * which streams a [SYSTEM] wake-up turn to the agent and unblocks the
 * task. Cancel dismisses without delivering — task stays blocked.
 *
 * Mirrors ApprovalCard structurally so the workspace renders a consistent
 * "what does the agent need from me" stack when both card kinds are open.
 */
export function QuestionCard({ question, options }: QuestionCardProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();

  const actionable = question.status === "pending";
  const canSubmit = actionable && (selectedIndex != null || text.trim().length > 0);

  function submit() {
    if (!canSubmit) return;
    start(async () => {
      const r = await answerQuestionAction(question.id, {
        option_index: selectedIndex,
        text: text.trim() || null,
      });
      if (!r.ok) {
        toast.error(r.error ?? "Failed to send answer");
        return;
      }
      toast.success("Sent — agent is being notified");
      // No local reset: the server action revalidates and the next render
      // shows the row with status='answered' (or it disappears from the
      // open list, depending on the wrapping component).
    });
  }

  function dismiss() {
    start(async () => {
      const r = await cancelQuestionAction(question.id);
      if (!r.ok) {
        toast.error(r.error ?? "Failed to dismiss");
        return;
      }
      toast.info(
        "Question dismissed. The task stays blocked until the agent or user takes another step.",
      );
    });
  }

  return (
    <Card
      className="overflow-hidden"
      role="region"
      aria-label={question.prompt}
      data-status={question.status}
    >
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="gap-1 text-[10px]">
                <MessageSquareQuote className="size-3" />
                Question
              </Badge>
              <Badge
                variant={actionable ? "default" : "outline"}
                className="text-[10px]"
              >
                {actionable
                  ? "Needs answer"
                  : question.status === "answered"
                    ? "Answered"
                    : "Dismissed"}
              </Badge>
            </div>
            <p className="text-sm font-medium leading-snug whitespace-pre-wrap">
              {question.prompt}
            </p>
            <p className="text-xs text-muted-foreground">
              Agent <span className="font-mono">{question.agent_id}</span> ·{" "}
              {timeAgo(question.created_at)}
            </p>
          </div>
        </div>

        {!actionable && (
          <ResolvedAnswer
            question={question}
            options={options}
          />
        )}

        {actionable && (
          <div className="space-y-3">
            {options.length > 0 && (
              <div
                className="grid gap-2"
                role="radiogroup"
                aria-label="Suggested answers"
              >
                {options.map((opt, idx) => {
                  const selected = idx === selectedIndex;
                  return (
                    <button
                      key={`${opt}-${idx}`}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() =>
                        setSelectedIndex((cur) => (cur === idx ? null : idx))
                      }
                      disabled={pending}
                      className={cn(
                        "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
                        selected
                          ? "border-sky-500/80 bg-sky-500/10 text-sky-950 dark:bg-sky-400/15 dark:text-sky-50"
                          : "border-border/70 hover:border-sky-500/60 hover:bg-sky-500/5",
                      )}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor={`q-${question.id}-text`}
                className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
              >
                {options.length > 0 ? "Or add a comment" : "Your answer"}
              </label>
              <textarea
                id={`q-${question.id}-text`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                placeholder={
                  options.length > 0
                    ? "Optional — add nuance to the option you picked, or answer free-form."
                    : "Type your answer…"
                }
                disabled={pending}
                className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={submit} disabled={pending || !canSubmit}>
                Send answer
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={dismiss}
                disabled={pending}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ResolvedAnswer({
  question,
  options,
}: {
  question: Question;
  options: string[];
}) {
  if (question.status === "cancelled") {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Dismissed without answer.
      </p>
    );
  }
  const chosen =
    question.answer_option_index != null
      ? (options[question.answer_option_index] ?? null)
      : null;
  const text = question.answer_text?.trim() || null;
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Answer
      </div>
      {chosen && (
        <p className="mt-1 font-medium leading-relaxed">{chosen}</p>
      )}
      {text && (
        <p
          className={cn(
            "whitespace-pre-wrap leading-relaxed",
            chosen ? "mt-1 text-muted-foreground" : "mt-1",
          )}
        >
          {text}
        </p>
      )}
      {!chosen && !text && (
        <p className="mt-1 italic text-muted-foreground">
          (empty answer)
        </p>
      )}
    </div>
  );
}
