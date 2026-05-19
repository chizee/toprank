"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  Gauge,
  Loader2,
  Plug,
  Search,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { startMcpConnect } from "@/server/actions/mcp";
import { createProjectForOnboardingAction } from "@/server/actions/projects";
import type {
  AuditSummary,
  Finding,
  FindingCategory,
  StreamEvent,
} from "@/lib/onboarding/events";

type Step = "name" | "connect" | "audit";

export function OnboardingFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const stepParam = params.get("step");
  const slug = params.get("slug") ?? null;
  const step: Step =
    stepParam === "connect" || stepParam === "audit"
      ? stepParam
      : "name";

  return (
    <div className="mx-auto w-full max-w-[720px] space-y-6 pt-8 pb-12">
      <a
        href="#onboarding-main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Skip to content
      </a>
      <main id="onboarding-main" className="space-y-6">
        {step === "name" && (
          <NameStep
            onCreated={(s) =>
              router.push(`/onboarding?step=connect&slug=${encodeURIComponent(s)}`)
            }
          />
        )}
        {step === "connect" && slug && <ConnectStep slug={slug} />}
        {step === "audit" && slug && <AuditStep slug={slug} />}
        {(step === "connect" || step === "audit") && !slug && (
          <MissingSlug />
        )}
      </main>
    </div>
  );
}

// ── Step 1: Name ───────────────────────────────────────────────────

function NameStep({ onCreated }: { onCreated: (slug: string) => void }) {
  const [state, formAction, isPending] = useActionState<
    | { ok: true; data: { slug: string; display_name: string } }
    | { ok: false; error: string }
    | null,
    FormData
  >(async (_prev, formData) => createProjectForOnboardingAction(formData), null);

  useEffect(() => {
    if (state && state.ok) onCreated(state.data.slug);
  }, [state, onCreated]);

  const errorMessage = state && !state.ok ? state.error : null;

  return (
    <>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Let&rsquo;s set up your CMO.
        </h1>
        <p className="text-sm text-muted-foreground">
          What should we call this project?
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project name</CardTitle>
          <CardDescription>
            A project groups the agents and crons your CMO will manage. The slug
            (used in agent names) is set once and immutable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="display_name">Name</Label>
              <Input
                id="display_name"
                name="display_name"
                required
                autoFocus
                placeholder="Acme Q4 launch"
                maxLength={80}
                disabled={isPending}
              />
            </div>
            {errorMessage && (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage}
              </p>
            )}
            <Button type="submit" size="lg" disabled={isPending}>
              {isPending ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              Continue
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}

// ── Step 2: Connect ────────────────────────────────────────────────

function ConnectStep({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onConnect() {
    setBusy(true);
    try {
      const result = await startMcpConnect({
        mcp_key: "notfair-googleads",
        return_to: `/onboarding?step=audit&slug=${encodeURIComponent(slug)}`,
      });
      if (!result.ok) {
        toast.error(result.error);
        setBusy(false);
        return;
      }
      // Cross-origin redirect to the OAuth issuer.
      window.location.href = result.authorize_url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function onSkip() {
    router.push("/agents/cmo/chat");
  }

  return (
    <>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Connect your Google Ads.
        </h1>
        <p className="text-sm text-muted-foreground">
          I&rsquo;ll read your account so I can show you what to fix. Read-only
          &mdash; I won&rsquo;t change anything yet.
        </p>
      </header>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap gap-2">
            <Button onClick={onConnect} disabled={busy} size="lg">
              {busy ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : (
                <Plug className="mr-1.5 size-4" />
              )}
              Connect Google Ads
            </Button>
            <Button
              onClick={onSkip}
              variant="ghost"
              disabled={busy}
              aria-label="Skip Google Ads connection for now and go to chat"
            >
              Skip for now
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            You can disconnect anytime in{" "}
            <Link href="/connections" className="underline underline-offset-2">
              Connections
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </>
  );
}

// ── Step 3: Audit (terminal) ───────────────────────────────────────

type AuditState =
  | { phase: "provisioning" }
  | { phase: "provision-timeout" }
  | { phase: "no-agents" }
  | { phase: "streaming" }
  | { phase: "complete-normal"; summary: AuditSummary }
  | { phase: "complete-empty"; summary: AuditSummary }
  | { phase: "error"; kind: string; message: string }
  | { phase: "persist-failed"; message: string };

function AuditStep({ slug }: { slug: string }) {
  const [audit, setAudit] = useState<AuditState>({ phase: "provisioning" });
  const [findings, setFindings] = useState<Finding[]>([]);
  const [categoryErrors, setCategoryErrors] = useState<
    Array<{ category: string; message: string }>
  >([]);
  const completeFocusRef = useRef<HTMLButtonElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(
      `/api/onboarding/stream?slug=${encodeURIComponent(slug)}`,
    );
    esRef.current = es;

    es.onmessage = (msg) => {
      let event: StreamEvent;
      try {
        event = JSON.parse(msg.data) as StreamEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case "provision:waiting":
          // Already showing the provisioning UI; nothing to do.
          break;
        case "provision:ready":
          setAudit({ phase: "streaming" });
          break;
        case "provision:timeout":
          setAudit({ phase: "provision-timeout" });
          es.close();
          break;
        case "provision:no-agents":
          setAudit({ phase: "no-agents" });
          es.close();
          break;
        case "audit:start":
          setAudit({ phase: "streaming" });
          break;
        case "audit:finding":
          setFindings((prev) => [...prev, event.finding]);
          break;
        case "audit:finding-error":
          setCategoryErrors((prev) => [
            ...prev,
            { category: event.category, message: event.message },
          ]);
          break;
        case "audit:empty":
          // The audit:complete event will set state to complete-empty with
          // the summary. Nothing to render eagerly here.
          break;
        case "audit:complete":
          setAudit(
            event.summary.account_state === "empty"
              ? { phase: "complete-empty", summary: event.summary }
              : { phase: "complete-normal", summary: event.summary },
          );
          es.close();
          break;
        case "audit:error":
          setAudit({ phase: "error", kind: event.kind, message: event.message });
          es.close();
          break;
        case "audit:persist-failed":
          setAudit({ phase: "persist-failed", message: event.message });
          es.close();
          break;
      }
    };

    es.onerror = () => {
      setAudit((prev) =>
        prev.phase === "complete-normal" ||
        prev.phase === "complete-empty" ||
        prev.phase === "error" ||
        prev.phase === "persist-failed"
          ? prev
          : {
              phase: "error",
              kind: "unreachable",
              message: "Lost connection to onboarding stream.",
            },
      );
      es.close();
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [slug]);

  useEffect(() => {
    if (
      (audit.phase === "complete-normal" || audit.phase === "complete-empty") &&
      completeFocusRef.current
    ) {
      completeFocusRef.current.focus();
    }
  }, [audit.phase]);

  return (
    <>
      <AuditHeader phase={audit.phase} findingsCount={findings.length} />

      {audit.phase === "provisioning" && <ProvisioningCard />}

      {audit.phase === "provision-timeout" && (
        <TimeoutCard
          title="Setting up took longer than expected."
          message="Your project is created but OpenClaw is slow."
        />
      )}

      {audit.phase === "no-agents" && (
        <TimeoutCard
          title="Setting up the project hasn't finished."
          message="Open this onboarding again from your project home to retry."
        />
      )}

      {(audit.phase === "streaming" ||
        audit.phase === "complete-normal" ||
        audit.phase === "complete-empty") &&
        findings.length > 0 && (
          <FindingsList
            findings={findings}
            topFixId={
              audit.phase === "complete-normal"
                ? audit.summary.top_fix_id
                : null
            }
            categoryErrors={categoryErrors}
          />
        )}

      {(audit.phase === "streaming" ||
        audit.phase === "complete-normal" ||
        audit.phase === "complete-empty") &&
        findings.length === 0 &&
        categoryErrors.length > 0 && (
          <PartialErrorBanner errors={categoryErrors} />
        )}

      {audit.phase === "complete-empty" && (
        <EmptyAccountRoadmap focusRef={completeFocusRef} />
      )}

      {audit.phase === "complete-normal" && (
        <CompleteFooterCtas focusRef={completeFocusRef} />
      )}

      {audit.phase === "error" && (
        <AuditErrorCard kind={audit.kind} message={audit.message} />
      )}

      {audit.phase === "persist-failed" && (
        <PersistFailedCard message={audit.message} />
      )}

      {/* One-shot announcement for screen readers. */}
      <div role="status" aria-live="polite" className="sr-only">
        {audit.phase === "complete-normal" &&
          `Audit complete. ${audit.summary.count} findings.`}
        {audit.phase === "complete-empty" &&
          "Audit complete. Looks like you're just getting started."}
      </div>
    </>
  );
}

function AuditHeader({
  phase,
  findingsCount,
}: {
  phase: AuditState["phase"];
  findingsCount: number;
}) {
  if (phase === "provisioning") return null;
  if (phase === "provision-timeout" || phase === "no-agents") return null;
  if (phase === "error" || phase === "persist-failed") return null;
  if (phase === "complete-empty") {
    return (
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Looks like you&rsquo;re just getting started.
        </h1>
        <p className="text-sm text-muted-foreground">
          I didn&rsquo;t find spend or campaigns in the last 30 days. Here&rsquo;s
          what I&rsquo;d build with you next.
        </p>
      </header>
    );
  }
  if (phase === "complete-normal") {
    return (
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Here&rsquo;s what I found.
        </h1>
        <p className="text-sm text-muted-foreground tabular-nums">
          Audit complete &middot; {findingsCount} finding
          {findingsCount === 1 ? "" : "s"}
        </p>
      </header>
    );
  }
  // streaming
  return (
    <header className="space-y-1" role="status">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">
        Looking at your Google Ads account&hellip;
      </h1>
      <p className="text-sm text-muted-foreground">
        Findings will land here as I work through your account.
      </p>
    </header>
  );
}

function ProvisioningCard() {
  return (
    <Card>
      <CardContent className="space-y-2 pt-6 pb-6">
        <div className="flex items-center gap-3 text-sm">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <span className="font-medium">Connecting your CMO to your account&hellip;</span>
        </div>
        <p className="text-xs text-muted-foreground pl-7">
          Just a few seconds. You&rsquo;ll see findings as soon as we&rsquo;re in.
        </p>
      </CardContent>
    </Card>
  );
}

function TimeoutCard({ title, message }: { title: string; message: string }) {
  return (
    <Card role="alert">
      <CardContent className="space-y-3 pt-6 pb-6">
        <div className="flex items-center gap-2">
          <AlertCircle className="size-4 text-amber-600" aria-hidden />
          <span className="font-medium text-sm">{title}</span>
        </div>
        <p className="text-xs text-muted-foreground">{message}</p>
        <div className="flex gap-2">
          <Button asChild>
            <Link href="/onboarding">Retry</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/agents/cmo/chat">Skip to chat</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FindingsList({
  findings,
  topFixId,
  categoryErrors,
}: {
  findings: Finding[];
  topFixId: string | null;
  categoryErrors: Array<{ category: string; message: string }>;
}) {
  // Pull the top fix to the top, keep others in order.
  const top = topFixId ? findings.find((f) => f.id === topFixId) : null;
  const rest = top ? findings.filter((f) => f.id !== top.id) : findings;
  return (
    <ol
      aria-live="polite"
      aria-relevant="additions"
      className="space-y-3 list-none p-0"
    >
      {top && <FindingCard finding={top} isTopFix />}
      {rest.map((f) => (
        <FindingCard key={f.id} finding={f} />
      ))}
      {categoryErrors.map((ce) => (
        <li key={`err:${ce.category}`} className="text-xs text-muted-foreground pl-7">
          <span className="inline-flex items-center gap-2">
            <AlertCircle className="size-3.5" aria-hidden />
            Couldn&rsquo;t check {ce.category.toLowerCase().replace(/_/g, " ")} &mdash;
            continuing with the rest.
          </span>
        </li>
      ))}
    </ol>
  );
}

const CATEGORY_ICON: Record<FindingCategory, React.ComponentType<{ className?: string }>> = {
  WASTED_SPEND: AlertTriangle,
  LOW_QS: Gauge,
  SEARCH_TERM_GAP: Search,
  BUDGET_PACING: TrendingUp,
};

function FindingCard({
  finding,
  isTopFix,
}: {
  finding: Finding;
  isTopFix?: boolean;
}) {
  const Icon = CATEGORY_ICON[finding.category];
  return (
    <li className="animate-in fade-in slide-in-from-bottom-1 duration-300">
      <Card className={cn(isTopFix && "ring-1 ring-foreground/10")}>
        <CardHeader className="pt-4 pb-2">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Icon className="size-4" aria-hidden />
            <span>
              {isTopFix && "TOP FIX · "}
              {finding.category.replace(/_/g, " ")}
            </span>
          </div>
        </CardHeader>
        <CardContent className="pt-0 pb-4 space-y-2">
          <p className="text-sm font-medium leading-snug text-foreground">
            {finding.headline}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {finding.evidence}
          </p>
          {isTopFix ? (
            <Button asChild size="lg" className="mt-2">
              <Link
                href={`/agents/cmo/chat?propose=${encodeURIComponent(finding.id)}`}
              >
                Fix this now
              </Link>
            </Button>
          ) : (
            <Button asChild variant="link" size="sm" className="px-0">
              <Link
                href={`/agents/cmo/chat?propose=${encodeURIComponent(finding.id)}`}
              >
                I&rsquo;ll fix this <ChevronRight className="ml-0.5 size-3.5" aria-hidden />
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

function CompleteFooterCtas({
  focusRef,
}: {
  focusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      <Button asChild variant="outline" size="lg">
        <Link
          href="/agents/cmo/chat"
          ref={focusRef as unknown as React.Ref<HTMLAnchorElement>}
        >
          Chat with CMO about all of this
        </Link>
      </Button>
    </div>
  );
}

function EmptyAccountRoadmap({
  focusRef,
}: {
  focusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where I&rsquo;d start</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            <strong>Set a daily budget for your first campaign.</strong> Most B2B
            starts at $50&ndash;100/day to gather signal.
          </p>
          <p>
            <strong>Decide your first goal:</strong> leads vs. traffic vs. brand.
            I can help you pick.
          </p>
          <p>
            <strong>Talk it through with me.</strong> Thirty minutes and
            you&rsquo;ll have a campaign brief.
          </p>
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-2 pt-2">
        <Button asChild size="lg">
          <Link
            href="/agents/cmo/chat"
            ref={focusRef as unknown as React.Ref<HTMLAnchorElement>}
          >
            Plan with CMO
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">I&rsquo;ll come back</Link>
        </Button>
      </div>
    </>
  );
}

function AuditErrorCard({ kind, message }: { kind: string; message: string }) {
  const headline =
    kind === "stale_token"
      ? "Google Ads token expired."
      : kind === "mcp_not_configured"
        ? "Google Ads isn't connected for this project."
        : kind === "timeout"
          ? "Audit timed out."
          : "Couldn't reach your Google Ads account.";
  return (
    <Card role="alert">
      <CardContent className="space-y-3 pt-6 pb-6">
        <div className="flex items-center gap-2">
          <AlertCircle className="size-4 text-amber-600" aria-hidden />
          <span className="font-medium text-sm">{headline}</span>
        </div>
        <p className="text-xs text-muted-foreground">{message}</p>
        <div className="flex gap-2">
          <Button asChild>
            <Link href="/onboarding">Retry</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/agents/cmo/chat">Skip to chat</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PersistFailedCard({ message }: { message: string }) {
  return (
    <Card role="alert">
      <CardContent className="space-y-3 pt-6 pb-6">
        <div className="flex items-center gap-2">
          <AlertCircle className="size-4 text-destructive" aria-hidden />
          <span className="font-medium text-sm">Couldn&rsquo;t save your audit.</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Check disk space or restart and try again. Detail: {message}
        </p>
        <Button asChild>
          <Link href="/onboarding">Retry</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function PartialErrorBanner({
  errors,
}: {
  errors: Array<{ category: string; message: string }>;
}) {
  return (
    <Card>
      <CardContent className="space-y-2 pt-6 pb-6 text-sm">
        <div className="flex items-center gap-2">
          <AlertCircle className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">
            Couldn&rsquo;t check {errors.length} categor
            {errors.length === 1 ? "y" : "ies"} &mdash; the rest came back clean.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function MissingSlug() {
  return (
    <Card>
      <CardContent className="space-y-3 pt-6 pb-6">
        <p className="text-sm text-muted-foreground">
          This step needs a project. Start from the beginning.
        </p>
        <Button asChild>
          <Link href="/onboarding">Start over</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
