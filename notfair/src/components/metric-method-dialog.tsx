"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * "How is this measured?" — the metric's exact provenance: which
 * connection, which tool, and the verbatim query/args the platform runs
 * at every check. The value is never self-reported by the agent; this
 * dialog is the proof.
 */
export function MetricMethodDialog({
  name,
  sourceKey,
  sourceTool,
  argsJson,
  direction,
}: {
  name: string;
  sourceKey: string | null;
  sourceTool: string | null;
  argsJson: string | null;
  direction: "increase" | "decrease" | null;
}) {
  const [open, setOpen] = useState(false);

  // The common shape is {"query": "<sql>"} — surface the query as code
  // and any remaining args as pretty JSON. Fall back to the raw string.
  let query: string | null = null;
  let otherArgs: string | null = null;
  if (argsJson) {
    try {
      const parsed = JSON.parse(argsJson) as Record<string, unknown>;
      if (typeof parsed.query === "string") {
        query = parsed.query;
        const rest = Object.fromEntries(
          Object.entries(parsed).filter(([k]) => k !== "query"),
        );
        if (Object.keys(rest).length > 0) otherArgs = JSON.stringify(rest, null, 2);
      } else {
        otherArgs = JSON.stringify(parsed, null, 2);
      }
    } catch {
      otherArgs = argsJson;
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`How is “${name}” measured?`}
          title="How is this measured?"
          className="inline-flex shrink-0 items-center text-[hsl(var(--notfair-ink-4))] transition-colors hover:text-[hsl(var(--notfair-ink-2))]"
        >
          <Info className="size-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-[14px]">{name}</DialogTitle>
          <DialogDescription>
            Re-measured by the platform at every check, straight from the
            source below — the agent never self-reports this number.
          </DialogDescription>
        </DialogHeader>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
          <dt className="text-[hsl(var(--notfair-ink-4))]">Connection</dt>
          <dd className="m-0 font-mono text-[12px]">{sourceKey ?? "—"}</dd>
          <dt className="text-[hsl(var(--notfair-ink-4))]">Tool</dt>
          <dd className="m-0 font-mono text-[12px]">{sourceTool ?? "—"}</dd>
          <dt className="text-[hsl(var(--notfair-ink-4))]">Direction</dt>
          <dd className="m-0">
            {direction === "decrease"
              ? "lower is better"
              : direction === "increase"
                ? "higher is better"
                : "—"}
          </dd>
        </dl>
        {query && (
          <div>
            <p className="m-0 mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--notfair-ink-4))]">
              Query run at every check
            </p>
            <pre className="m-0 overflow-x-auto rounded-xl bg-[hsl(var(--notfair-surface-2))] p-3 text-[11.5px] leading-relaxed">
              <code>{query}</code>
            </pre>
          </div>
        )}
        {otherArgs && (
          <div>
            <p className="m-0 mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--notfair-ink-4))]">
              {query ? "Other arguments" : "Arguments"}
            </p>
            <pre className="m-0 overflow-x-auto rounded-xl bg-[hsl(var(--notfair-surface-2))] p-3 text-[11.5px] leading-relaxed">
              <code>{otherArgs}</code>
            </pre>
          </div>
        )}
        {!query && !otherArgs && (
          <p className="m-0 text-[12px] text-[hsl(var(--notfair-ink-4))]">
            No measurement definition recorded — the metric is still being
            set up in chat.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
