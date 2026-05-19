"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { STEP_ORDER, type StepId, type StepPreview } from "@/lib/onboarding/steps";

type StepState = "pending" | "running" | "done" | "error";

type StepEntry = {
  state: StepState;
  preview?: StepPreview;
  errorMessage?: string;
};

const PLACEHOLDER_LABELS: Record<StepId, string> = {
  scrape: "site scrape",
  voice: "brand voice fingerprint",
  icp: "ICP hypothesis",
  plan: "30-day plan",
};

type SseEvent =
  | { type: "step:start"; id: StepId }
  | { type: "step:done"; id: StepId; preview: StepPreview }
  | { type: "step:error"; id: StepId; message: string }
  | { type: "complete" };

function initialEntries(): Record<StepId, StepEntry> {
  return {
    scrape: { state: "pending" },
    voice: { state: "pending" },
    icp: { state: "pending" },
    plan: { state: "pending" },
  };
}

export function OnboardingFlow() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [entries, setEntries] = useState<Record<StepId, StepEntry>>(initialEntries);
  const [active, setActive] = useState(false);
  const [complete, setComplete] = useState(false);
  const [announce, setAnnounce] = useState("");
  const approveRef = useRef<HTMLButtonElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (complete && approveRef.current) {
      approveRef.current.focus();
    }
  }, [complete]);

  function start() {
    if (!url.trim()) {
      toast.error("Enter your site URL first.");
      return;
    }
    setEntries(initialEntries());
    setComplete(false);
    setActive(true);
    setAnnounce("Starting onboarding.");

    const es = new EventSource(`/api/onboarding/stream?url=${encodeURIComponent(url.trim())}`);
    esRef.current = es;

    es.onmessage = (msg) => {
      let data: SseEvent;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }

      if (data.type === "step:start") {
        const label = STEP_ORDER.find((s) => s.id === data.id)?.label ?? data.id;
        setAnnounce(`${label} in progress.`);
        setEntries((prev) => ({ ...prev, [data.id]: { state: "running" } }));
      } else if (data.type === "step:done") {
        const label = STEP_ORDER.find((s) => s.id === data.id)?.label ?? data.id;
        setAnnounce(`${label} complete.`);
        setEntries((prev) => ({ ...prev, [data.id]: { state: "done", preview: data.preview } }));
      } else if (data.type === "step:error") {
        const label = PLACEHOLDER_LABELS[data.id];
        setAnnounce(`Used placeholder for ${label}.`);
        setEntries((prev) => ({
          ...prev,
          [data.id]: { state: "error", errorMessage: data.message },
        }));
      } else if (data.type === "complete") {
        setComplete(true);
        setAnnounce("Your 30-day plan is ready.");
        es.close();
        esRef.current = null;
      }
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      toast.error("Lost connection to the onboarding stream.");
      setActive(false);
    };
  }

  function goToChat(message: string) {
    toast(message);
    router.push("/");
  }

  return (
    <div className="mx-auto w-full max-w-[720px] space-y-6 pt-8 pb-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Let&rsquo;s set up your CMO.
        </h1>
        <p className="text-sm text-muted-foreground">
          Paste your site URL. The CMO scrapes it, learns your voice, drafts an ICP,
          and proposes a 30-day plan.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Site URL</CardTitle>
          <CardDescription>This is the only thing you need to provide right now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="url">URL</Label>
            <Input
              id="url"
              placeholder="https://yourcompany.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={active}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !active) {
                  e.preventDefault();
                  start();
                }
              }}
            />
          </div>
          {!active && (
            <Button onClick={start} disabled={!url.trim()}>
              Go
            </Button>
          )}
        </CardContent>
      </Card>

      {active && (
        <Card aria-busy={!complete}>
          <CardHeader>
            <CardTitle className="text-base">Building your plan</CardTitle>
            <CardDescription>This usually takes about 30 seconds.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4">
              {STEP_ORDER.map((step) => {
                const entry = entries[step.id];
                return (
                  <li key={step.id} className="space-y-2">
                    <div className="flex items-center gap-3 text-sm">
                      <StepIcon state={entry.state} />
                      <span
                        className={cn(
                          entry.state === "running" && "font-medium text-foreground",
                          entry.state === "pending" && "text-muted-foreground",
                          entry.state === "done" && "text-foreground",
                          entry.state === "error" && "text-foreground",
                        )}
                      >
                        {step.label}
                      </span>
                    </div>

                    {entry.state === "done" && entry.preview && (
                      <PreviewBlock preview={entry.preview} />
                    )}

                    {entry.state === "error" && (
                      <div className="ml-7 rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-xs text-muted-foreground dark:border-zinc-700 dark:bg-zinc-900">
                        Used placeholder for {PLACEHOLDER_LABELS[step.id]}; CMO will refine over time.
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
      )}

      {complete && <PlanCard approveRef={approveRef} onChat={goToChat} entries={entries} />}

      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
    </div>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") {
    return <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />;
  }
  if (state === "running") {
    return <Loader2 className="size-4 animate-spin text-zinc-500" aria-hidden />;
  }
  if (state === "error") {
    return <AlertCircle className="size-4 text-amber-600" aria-hidden />;
  }
  return <div className="size-4 rounded-full border border-zinc-300 dark:border-zinc-700" aria-hidden />;
}

function PreviewBlock({ preview }: { preview: StepPreview }) {
  if (preview.kind === "scrape") {
    return (
      <div className="ml-7 rounded-md border bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-900">
        <div className="font-medium text-foreground">{preview.title}</div>
        <div className="text-muted-foreground">{preview.description}</div>
        <div className="text-muted-foreground">{preview.pages} pages indexed.</div>
      </div>
    );
  }
  if (preview.kind === "voice") {
    return (
      <div className="ml-7 rounded-md border bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-900">
        <div className="text-foreground">{preview.tone}</div>
        <div className="text-muted-foreground">
          Adjectives: {preview.adjectives.join(", ")}
        </div>
        <div className="mt-1 text-muted-foreground italic">&ldquo;{preview.sample}&rdquo;</div>
      </div>
    );
  }
  if (preview.kind === "icp") {
    return (
      <div className="ml-7 rounded-md border bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-900">
        <div className="font-medium text-foreground">{preview.segment}</div>
        <div className="text-muted-foreground">Pains: {preview.pains.join("; ")}</div>
        <div className="text-muted-foreground">Channels: {preview.channels.join(", ")}</div>
      </div>
    );
  }
  if (preview.kind === "plan") {
    return (
      <div className="ml-7 rounded-md border bg-zinc-50 px-3 py-2 text-xs text-muted-foreground dark:bg-zinc-900">
        {preview.weeks.length} weeks of actions queued. See plan below.
      </div>
    );
  }
  return null;
}

function PlanCard({
  approveRef,
  onChat,
  entries,
}: {
  approveRef: React.RefObject<HTMLButtonElement | null>;
  onChat: (message: string) => void;
  entries: Record<StepId, StepEntry>;
}) {
  const planPreview = entries.plan.preview;
  const weeks =
    planPreview && planPreview.kind === "plan"
      ? planPreview.weeks
      : [
          { label: "Week 1", items: ["Audit Google Ads"] },
          { label: "Week 2", items: ["Cold email sequence"] },
          { label: "Week 3", items: ["Bid optimization"] },
          { label: "Week 4", items: ["Review and reallocate"] },
        ];

  return (
    <Card aria-label="Your 30-day plan">
      <CardHeader>
        <CardTitle className="text-base">Your 30-day plan</CardTitle>
        <CardDescription>
          A starting point. Your CMO will refine this as it learns from results.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {weeks.map((w) => (
            <div
              key={w.label}
              className="rounded-md border bg-zinc-50/50 p-3 text-sm dark:bg-zinc-900/50"
            >
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {w.label}
              </div>
              <ul className="space-y-1.5 text-foreground">
                {w.items.map((item, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            ref={approveRef}
            onClick={() => onChat("Plan approved — CMO will start working on Week 1.")}
          >
            Approve &amp; launch
          </Button>
          <Button
            variant="outline"
            onClick={() => onChat("Opening plan editor in chat.")}
          >
            Edit plan
          </Button>
          <Button
            variant="ghost"
            onClick={() => onChat("Saved. You can come back to this plan anytime.")}
          >
            Save &amp; decide later
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
