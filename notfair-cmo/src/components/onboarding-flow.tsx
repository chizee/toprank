"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertCircle, ChevronRight, FolderOpen, Loader2, Plug } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { projectHref } from "@/lib/project-href";
import { startMcpConnect } from "@/server/actions/mcp";
import { createProjectForOnboardingAction } from "@/server/actions/projects";
import {
  listGoogleAdsAccounts,
  setOnboardingAccountAction,
  getOnboardingTaskForSkipAction,
  getProvisioningProgressAction,
  type GoogleAdsAccount,
} from "@/server/onboarding/accounts";

type Step = "name" | "connect" | "account" | "setup";

export function OnboardingFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const stepParam = params.get("step");
  const slug = params.get("slug") ?? null;
  const step: Step =
    stepParam === "connect" || stepParam === "account" || stepParam === "setup"
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
        {step === "account" && slug && <AccountStep slug={slug} />}
        {step === "setup" && slug && <SetupStep slug={slug} />}
        {(step === "connect" || step === "account" || step === "setup") && !slug && (
          <MissingSlug />
        )}
      </main>
    </div>
  );
}

// ── Codebase folder picker (Step 1 helper) ─────────────────────────
//
// Browsers don't expose absolute paths from `<input type="file"
// webkitdirectory>` or `showDirectoryPicker()` — security. Since this
// server runs on the user's own machine (loopback only), we shell out
// to the OS-native folder dialog via POST /api/fs/pick-folder and let
// the OS handle the picker UI. The field stays editable so users on
// platforms we don't yet support natively (Linux, Windows) can paste.

function CodebasePathPicker({ disabled }: { disabled: boolean }) {
  const [value, setValue] = useState("");
  const [picking, setPicking] = useState(false);

  async function onBrowse() {
    setPicking(true);
    try {
      const res = await fetch("/api/fs/pick-folder", { method: "POST" });
      const body = (await res.json()) as
        | { ok: true; path: string }
        | { ok: false; kind: "cancelled" }
        | { ok: false; kind: "unsupported" | "error"; message?: string };
      if (body.ok) {
        setValue(body.path);
        return;
      }
      if (body.kind === "cancelled") return; // silent — user closed dialog
      toast.error(body.message ?? "Couldn't open the folder picker.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="flex gap-2">
      <Input
        id="codebase_path"
        name="codebase_path"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="No folder selected"
        maxLength={500}
        disabled={disabled || picking}
        readOnly={picking}
        aria-label="Local codebase folder"
      />
      <Button
        type="button"
        variant="outline"
        onClick={onBrowse}
        disabled={disabled || picking}
        aria-label="Browse for a folder"
      >
        {picking ? (
          <Loader2 className="mr-1.5 size-4 animate-spin" />
        ) : (
          <FolderOpen className="mr-1.5 size-4" />
        )}
        Browse&hellip;
      </Button>
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
          Tell me what this project is so I can hit the ground running.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project basics</CardTitle>
          <CardDescription>
            Name is required. Site and codebase are optional but help the
            CMO write a more accurate first plan. Slug (used in agent
            names) is derived from the name and immutable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="display_name">Project name</Label>
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

            <div className="rounded-md border border-dashed bg-muted/30 p-3 space-y-3">
              <div className="space-y-1">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Your team
                </Label>
                <p className="text-xs text-muted-foreground">
                  Name your CMO and Google Ads specialist. Pick something
                  memorable — these stay fixed for the life of the project.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label
                    htmlFor="agent_name_cmo"
                    className="text-xs font-medium text-foreground"
                  >
                    CMO
                  </Label>
                  <Input
                    id="agent_name_cmo"
                    name="agent_name_cmo"
                    defaultValue="Greg"
                    placeholder="Greg"
                    maxLength={32}
                    disabled={isPending}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="agent_name_google_ads"
                    className="text-xs font-medium text-foreground"
                  >
                    Google Ads
                  </Label>
                  <Input
                    id="agent_name_google_ads"
                    name="agent_name_google_ads"
                    defaultValue="Ana"
                    placeholder="Ana"
                    maxLength={32}
                    disabled={isPending}
                    required
                  />
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="website_url">
                Website URL{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="website_url"
                name="website_url"
                type="url"
                placeholder="https://acme.com"
                maxLength={500}
                disabled={isPending}
              />
              <p className="text-xs text-muted-foreground">
                The CMO will skim a few pages to learn what you sell.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="codebase_path">
                Local codebase folder{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <CodebasePathPicker disabled={isPending} />
              <p className="text-xs text-muted-foreground">
                Folder the CMO can read locally — README, package.json,
                top-level files. Skim only, not a code review.
              </p>
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
  const connectionsHref = projectHref(slug, "/connections");

  async function onConnect() {
    setBusy(true);
    try {
      const result = await startMcpConnect({
        mcp_key: "notfair-googleads",
        return_to: `/onboarding?step=account&slug=${encodeURIComponent(slug)}`,
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
    // Hand off to the dedicated setup screen instead of redirecting
    // straight to the task. The setup screen waits for `ensureProjectAgents`
    // to finish (publishing per-template progress) and only then resolves
    // the CMO + first-task slugs and navigates the user in.
    router.replace(
      `/onboarding?step=setup&slug=${encodeURIComponent(slug)}&from=skip`,
    );
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
              aria-label="Skip Google Ads connection for now and go to CMO tasks"
            >
              Skip for now
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            You can disconnect anytime in{" "}
            <Link href={connectionsHref} className="underline underline-offset-2">
              Connections
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </>
  );
}

// ── Step 2.5: Setup (post-skip-or-connect provisioning watcher) ────

type ProgressStep = {
  key: string;
  label: string;
  status: string;
  error?: string;
};

function statusGlyph(status: string): string {
  if (status === "done") return "✓";
  if (status === "failed") return "✗";
  if (status === "in_progress") return "•";
  return "·";
}

function SetupStep({ slug }: { slug: string }) {
  const router = useRouter();
  const [steps, setSteps] = useState<ProgressStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const redirectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      if (cancelled) return;
      try {
        const r = await getProvisioningProgressAction(slug);
        if (cancelled) return;
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setSteps(r.steps);
        if (r.overall === "failed") {
          const failed = r.steps.find((s) => s.status === "failed");
          setError(failed?.error ?? "Provisioning failed.");
          return;
        }
        if (r.overall === "done") {
          // Resolve the CMO + first task slugs and forward to the live
          // task workspace. Guarded so React StrictMode's double-mount
          // doesn't fire two redirects.
          if (redirectedRef.current) return;
          redirectedRef.current = true;
          const dest = await getOnboardingTaskForSkipAction(slug);
          if (cancelled) return;
          if (!dest.ok) {
            setError(dest.error);
            redirectedRef.current = false;
            return;
          }
          router.replace(
            projectHref(
              slug,
              `/agents/${dest.cmo_agent_slug}/tasks?task=${encodeURIComponent(dest.task_display_id)}`,
            ),
          );
          return;
        }
        // Still running — poll again. 500ms keeps the rows feeling
        // alive without hammering the server.
        pollTimer = setTimeout(poll, 500);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [slug, router]);

  return (
    <>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Setting up your agents.
        </h1>
        <p className="text-sm text-muted-foreground">
          One moment — provisioning your team in OpenClaw.
        </p>
      </header>

      <Card>
        <CardContent className="pt-6">
          <ul className="space-y-2" role="status" aria-live="polite">
            {steps.length === 0 && !error && (
              <li className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Starting…
              </li>
            )}
            {steps.map((s) => (
              <li
                key={s.key}
                className="flex items-center gap-2 text-sm"
                data-status={s.status}
              >
                <span
                  aria-hidden
                  className={
                    s.status === "done"
                      ? "inline-flex size-4 items-center justify-center font-mono text-emerald-600"
                      : s.status === "failed"
                        ? "inline-flex size-4 items-center justify-center font-mono text-destructive"
                        : s.status === "in_progress"
                          ? "inline-flex size-4 items-center justify-center"
                          : "inline-flex size-4 items-center justify-center font-mono text-muted-foreground"
                  }
                >
                  {s.status === "in_progress" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    statusGlyph(s.status)
                  )}
                </span>
                <span
                  className={
                    s.status === "done"
                      ? "text-foreground"
                      : s.status === "failed"
                        ? "text-destructive"
                        : s.status === "in_progress"
                          ? "text-foreground"
                          : "text-muted-foreground"
                  }
                >
                  {s.label}
                </span>
                {s.error && (
                  <span className="ml-2 text-xs text-destructive">
                    {s.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {error && (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

// ── Step 3: Pick Google Ads account (auto-skipped if only 1) ───────

type AccountListState =
  | { phase: "loading" }
  | { phase: "loaded"; accounts: GoogleAdsAccount[]; default_account_id: string | null }
  | { phase: "error"; message: string };

function AccountStep({ slug }: { slug: string }) {
  const router = useRouter();
  const [state, setState] = useState<AccountListState>({ phase: "loading" });
  const [pickingId, setPickingId] = useState<string | null>(null);
  // Guard against StrictMode double-mount auto-selecting twice.
  const autoSelectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listGoogleAdsAccounts(slug);
      if (cancelled) return;
      if (!result.ok) {
        setState({
          phase: "error",
          message: result.error,
        });
        return;
      }
      setState({
        phase: "loaded",
        accounts: result.accounts,
        default_account_id: result.default_account_id,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Auto-skip when there's exactly one account — no point making the user
  // pick from a list of one. We still call the server action so the project
  // row gets the id persisted, then forward to the audit step.
  useEffect(() => {
    if (state.phase !== "loaded") return;
    if (state.accounts.length !== 1) return;
    if (autoSelectedRef.current) return;
    autoSelectedRef.current = true;
    (async () => {
      const only = state.accounts[0]!;
      const result = await setOnboardingAccountAction(slug, only.id);
      if (!result.ok) {
        toast.error(result.error);
        setState({ phase: "error", message: result.error });
        return;
      }
      // Land on the CMO's task workspace with the freshly-created audit
      // task pre-selected — startTaskIfProposed kicks it off, the user
      // watches it run live in the standard task UX.
      router.replace(
        projectHref(
          slug,
          `/agents/${result.cmo_agent_slug}/tasks?task=${encodeURIComponent(result.task_display_id)}`,
        ),
      );
    })();
  }, [state, slug, router]);

  async function onPick(account: GoogleAdsAccount) {
    setPickingId(account.id);
    try {
      const result = await setOnboardingAccountAction(slug, account.id);
      if (!result.ok) {
        toast.error(result.error);
        setPickingId(null);
        return;
      }
      router.replace(
        projectHref(
          slug,
          `/agents/${result.cmo_agent_slug}/tasks?task=${encodeURIComponent(result.task_display_id)}`,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setPickingId(null);
    }
  }

  if (state.phase === "loading") {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6 pb-6">
          <div className="flex items-center gap-3 text-sm">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            <span className="font-medium">Loading your Google Ads accounts&hellip;</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (state.phase === "error") {
    return (
      <Card role="alert">
        <CardContent className="space-y-3 pt-6 pb-6">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 text-amber-600" aria-hidden />
            <span className="font-medium text-sm">
              Couldn&rsquo;t load your Google Ads accounts.
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{state.message}</p>
          <div className="flex gap-2">
            <Button asChild>
              <Link href="/onboarding">Retry from start</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={projectHref(slug, "")}>Skip to project</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (state.accounts.length === 0) {
    return (
      <Card role="alert">
        <CardContent className="space-y-3 pt-6 pb-6">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 text-amber-600" aria-hidden />
            <span className="font-medium text-sm">
              No Google Ads accounts found on this connection.
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            The connected user has no Google Ads customer accounts. Connect a
            different account or skip and chat with your CMO.
          </p>
          <div className="flex gap-2">
            <Button asChild>
              <Link href={`/onboarding?step=connect&slug=${encodeURIComponent(slug)}`}>
                Reconnect
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={projectHref(slug, "")}>Skip to project</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // length === 1 → auto-selecting via effect above; render the same loading
  // card so there's no flash of the picker UI.
  if (state.accounts.length === 1) {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6 pb-6">
          <div className="flex items-center gap-3 text-sm">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            <span className="font-medium">
              Using your only Google Ads account&hellip;
            </span>
          </div>
        </CardContent>
      </Card>
    );
  }

  // length > 1 → picker.
  return (
    <>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Which Google Ads account?
        </h1>
        <p className="text-sm text-muted-foreground">
          Your connection has {state.accounts.length} accounts. Pick the one
          you want me to audit for this project. You can switch later in
          Settings.
        </p>
      </header>

      <ul className="space-y-2 list-none p-0">
        {state.accounts.map((account) => {
          const isDefault = account.id === state.default_account_id;
          const isPicking = pickingId === account.id;
          const isOtherPicking = pickingId !== null && !isPicking;
          return (
            <li key={account.id}>
              <button
                type="button"
                onClick={() => onPick(account)}
                disabled={pickingId !== null}
                aria-label={`Audit ${account.name} (${account.id})`}
                className={cn(
                  "block w-full rounded-md border bg-card p-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 disabled:cursor-not-allowed",
                  isOtherPicking && "opacity-50",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{account.name}</span>
                      {isDefault && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          default
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      Customer ID {account.id}
                    </p>
                  </div>
                  {isPicking ? (
                    <Loader2
                      className="size-4 animate-spin text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </>
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
