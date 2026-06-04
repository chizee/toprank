"use client";

import { Suspense, useActionState, useEffect, useRef, useState } from "react";
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
  getConnectStepStateAction,
  listMetaAdsAccounts,
  setOnboardingMetaAdsAccountAction,
  listGscProperties,
  setOnboardingGscPropertyAction,
  type GoogleAdsAccount,
  type MetaAdsAccount,
  type GscProperty,
  type ConnectStepState,
} from "@/server/onboarding/accounts";
import { BrowseConnectorsDialog } from "@/components/browse-connectors-dialog";

type Step =
  | "name"
  | "connect"
  | "account"
  | "meta-account"
  | "gsc-property"
  | "setup";

export function OnboardingFlow() {
  return (
    <Suspense fallback={null}>
      <OnboardingFlowInner />
    </Suspense>
  );
}

function OnboardingFlowInner() {
  const router = useRouter();
  const params = useSearchParams();
  const stepParam = params.get("step");
  const slug = params.get("slug") ?? null;
  const step: Step =
    stepParam === "connect" ||
    stepParam === "account" ||
    stepParam === "meta-account" ||
    stepParam === "gsc-property" ||
    stepParam === "setup"
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
        {step === "meta-account" && slug && <MetaAccountStep slug={slug} />}
        {step === "gsc-property" && slug && <GscPropertyStep slug={slug} />}
        {step === "setup" && slug && <SetupStep slug={slug} />}
        {(step === "connect" ||
          step === "account" ||
          step === "meta-account" ||
          step === "gsc-property" ||
          step === "setup") &&
          !slug && <MissingSlug />}
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
          Tell me what this workspace is so I can hit the ground running.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace basics</CardTitle>
          <CardDescription>
            Name is required. Site and codebase are optional but help the
            CMO write a more accurate first plan. Slug (used in agent
            names) is derived from the name and immutable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="display_name">Workspace name</Label>
              <Input
                id="display_name"
                name="display_name"
                required
                autoFocus
                placeholder="Notfair"
                maxLength={80}
                disabled={isPending}
              />
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
                placeholder="https://notfair.co"
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
            <HarnessPicker disabled={isPending} />
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

// ── Harness picker ─────────────────────────────────────────────────
//
// Two adapters: Codex (recommended default) and Claude Code. Persisted on
// the project row so different projects can use different harnesses. The
// chosen CLI must be on PATH when chats run — adapter testEnvironment is
// surfaced via the doctor command for diagnostic feedback.

function HarnessPicker({ disabled }: { disabled: boolean }) {
  const [value, setValue] = useState<"claude-code-local" | "codex-local">(
    "codex-local",
  );
  const options: Array<{
    id: "claude-code-local" | "codex-local";
    label: string;
    description: string;
    recommended: boolean;
  }> = [
    {
      id: "codex-local",
      label: "Codex",
      description: "Uses your local `codex` CLI. Recommended.",
      recommended: true,
    },
    {
      id: "claude-code-local",
      label: "Claude Code",
      description: "Uses your local `claude` CLI.",
      recommended: false,
    },
  ];
  return (
    <div className="rounded-md border border-dashed bg-muted/30 p-3 space-y-3">
      <div className="space-y-1">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          AI agent runtime
        </Label>
        <p className="text-xs text-muted-foreground">
          Pick which local CLI runs your agents. You can have different
          projects on different harnesses.
        </p>
      </div>
      <input type="hidden" name="harness_adapter" value={value} />
      <div className="grid grid-cols-2 gap-2">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => setValue(opt.id)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition-colors",
              value === opt.id
                ? "border-foreground bg-background"
                : "border-border bg-background/40 hover:bg-background/80",
              disabled && "opacity-60",
            )}
            aria-pressed={value === opt.id}
          >
            <div className="flex w-full items-center justify-between">
              <span className="text-sm font-medium text-foreground">{opt.label}</span>
              {opt.recommended && (
                <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                  Recommended
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{opt.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Step 2: Connect ────────────────────────────────────────────────

/**
 * Spec for one of the recommended-MCP tiles in the connect step. The three
 * recommended MCPs (Google Ads, Meta Ads, Google Search Console) each get
 * their own first-class tile because connecting them triggers the
 * provisioning of a matching specialist agent.
 */
type RecommendedTile = {
  mcp_key: string;
  display_name: string;
  /** Short description shown under the title when the tile isn't connected. */
  description: string;
  /** Sub-step the OAuth callback should land on so the user can pick an
   *  account/property when their token covers more than one. */
  account_step: "account" | "meta-account" | "gsc-property";
  /** Label for the "Select X" sub-action when connected but not selected. */
  account_action_label: string;
};

const RECOMMENDED_TILES: RecommendedTile[] = [
  {
    mcp_key: "notfair-googleads",
    display_name: "Google Ads",
    description: "Campaigns, bids, keywords, search terms, change history.",
    account_step: "account",
    account_action_label: "Select Google Ads account",
  },
  {
    mcp_key: "notfair-metaads",
    display_name: "Meta Ads",
    description: "Facebook + Instagram campaigns, ad sets, creative, insights.",
    account_step: "meta-account",
    account_action_label: "Select Meta ad account",
  },
  {
    mcp_key: "notfair-googlesearchconsole",
    display_name: "Google Search Console",
    description: "Organic search performance, queries, pages, indexing.",
    account_step: "gsc-property",
    account_action_label: "Select GSC property",
  },
];

type ConnectStepStateView =
  | { phase: "loading" }
  | { phase: "loaded"; state: ConnectStepState }
  | { phase: "error"; message: string };

function ConnectStep({ slug }: { slug: string }) {
  const router = useRouter();
  const [view, setView] = useState<ConnectStepStateView>({ phase: "loading" });
  const [moreOpen, setMoreOpen] = useState(false);
  const [tileBusy, setTileBusy] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const connectionsHref = projectHref(slug, "/connections");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await getConnectStepStateAction(slug);
      if (cancelled) return;
      if (!result.ok) {
        setView({ phase: "error", message: result.error });
        return;
      }
      setView({ phase: "loaded", state: result.state });
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function onConnectTile(tile: RecommendedTile) {
    setTileBusy(tile.mcp_key);
    try {
      const result = await startMcpConnect({
        mcp_key: tile.mcp_key,
        // After OAuth lands, route through the matching account-picker
        // step. That step auto-skips if the bearer covers a single
        // account/property; otherwise it shows a picker. Both paths
        // ultimately redirect back to /onboarding?step=connect so the
        // user can continue adding tools.
        return_to: `/onboarding?step=${tile.account_step}&slug=${encodeURIComponent(slug)}`,
      });
      if (!result.ok) {
        toast.error(result.error);
        setTileBusy(null);
        return;
      }
      window.location.href = result.authorize_url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setTileBusy(null);
    }
  }

  function onPickAccount(tile: RecommendedTile) {
    router.push(
      `/onboarding?step=${tile.account_step}&slug=${encodeURIComponent(slug)}`,
    );
  }

  async function onDone() {
    setAdvancing(true);
    // The setup step waits for ensureProjectAgents (CMO + any specialists
    // provisioned by the connect-time hooks) and only then routes the user
    // into the CMO task workspace. Going through it instead of the direct
    // task URL means we don't race agent registration with the gateway
    // snapshot on a fresh project.
    router.replace(
      `/onboarding?step=setup&slug=${encodeURIComponent(slug)}&from=connect`,
    );
  }

  function onSkip() {
    router.replace(
      `/onboarding?step=setup&slug=${encodeURIComponent(slug)}&from=skip`,
    );
  }

  if (view.phase === "loading") {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6 pb-6">
          <div className="flex items-center gap-3 text-sm">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            <span className="font-medium">Loading your connections&hellip;</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (view.phase === "error") {
    return (
      <Card role="alert">
        <CardContent className="space-y-3 pt-6 pb-6">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 text-amber-600" aria-hidden />
            <span className="font-medium text-sm">
              Couldn&rsquo;t load connection state.
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{view.message}</p>
          <Button asChild>
            <Link href="/onboarding">Start over</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { state } = view;
  const tileStateByKey = {
    "notfair-googleads": state.googleads,
    "notfair-metaads": state.metaads,
    "notfair-googlesearchconsole": state.gsc,
  } as const;
  const anyConnected =
    state.googleads.connected ||
    state.metaads.connected ||
    state.gsc.connected ||
    state.extra_connected_count > 0;

  return (
    <>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Connect your tools.
        </h1>
        <p className="text-sm text-muted-foreground">
          Each tool you connect lets one of your specialist agents come
          online. Read-only at first &mdash; nothing changes until you
          approve a write.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {RECOMMENDED_TILES.map((tile) => (
          <RecommendedConnectorTile
            key={tile.mcp_key}
            tile={tile}
            state={tileStateByKey[tile.mcp_key as keyof typeof tileStateByKey]}
            busy={tileBusy === tile.mcp_key}
            disabled={tileBusy !== null && tileBusy !== tile.mcp_key}
            onConnect={() => onConnectTile(tile)}
            onPickAccount={() => onPickAccount(tile)}
          />
        ))}
        <MoreConnectorsTile
          extraConnectedCount={state.extra_connected_count}
          onOpen={() => setMoreOpen(true)}
        />
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6 pb-6">
          <p className="text-xs text-muted-foreground">
            You can connect, disconnect, or add custom MCPs anytime in{" "}
            <Link href={connectionsHref} className="underline underline-offset-2">
              Connections
            </Link>
            .
          </p>
          {anyConnected ? (
            <Button onClick={onDone} disabled={advancing} size="lg">
              {advancing && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Done adding MCPs &mdash; next step
            </Button>
          ) : (
            <Button
              onClick={onSkip}
              variant="ghost"
              disabled={advancing}
            >
              Skip for now
            </Button>
          )}
        </CardContent>
      </Card>

      <BrowseConnectorsDialog
        open={moreOpen}
        onOpenChange={setMoreOpen}
        // Hide the three recommended MCPs — they each have their own tile
        // above, so showing them in the More dialog would be a duplicate.
        hideKeys={RECOMMENDED_TILES.map((t) => t.mcp_key)}
        connectedKeys={[
          ...(state.googleads.connected ? ["notfair-googleads"] : []),
          ...(state.metaads.connected ? ["notfair-metaads"] : []),
          ...(state.gsc.connected ? ["notfair-googlesearchconsole"] : []),
        ]}
      />
    </>
  );
}

function RecommendedConnectorTile({
  tile,
  state,
  busy,
  disabled,
  onConnect,
  onPickAccount,
}: {
  tile: RecommendedTile;
  state: { connected: boolean; account_selected: boolean };
  busy: boolean;
  disabled: boolean;
  onConnect: () => void;
  onPickAccount: () => void;
}) {
  if (state.connected) {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
        <div className="flex items-start gap-2">
          <div className="size-2 mt-1.5 rounded-full bg-emerald-500" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{tile.display_name}</p>
            <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-400">
              Connected
              {state.account_selected ? " · account selected" : null}
            </p>
          </div>
        </div>
        {state.account_selected ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onPickAccount}
            disabled={disabled}
            className="self-start"
          >
            {tile.account_action_label}
          </Button>
        )}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={busy || disabled}
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{tile.display_name}</p>
        {busy ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <Plug className="size-3.5 text-muted-foreground" />
        )}
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2">
        {tile.description}
      </p>
    </button>
  );
}

function MoreConnectorsTile({
  extraConnectedCount,
  onOpen,
}: {
  extraConnectedCount: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-card p-4 text-left transition-colors hover:bg-muted/40"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">More tools</p>
        {extraConnectedCount > 0 ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-400">
            {extraConnectedCount} connected
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2">
        Stripe, Supabase, PostHog, and any custom MCP you want to wire up.
      </p>
    </button>
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
      // Back to the connect step so the user can wire up the rest of
      // their tools. The CMO audit task is minted by
      // setOnboardingAccountAction and stays blocked behind the
      // project-onboarding task until the user clicks "Done — next step".
      router.replace(
        `/onboarding?step=connect&slug=${encodeURIComponent(slug)}`,
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
        `/onboarding?step=connect&slug=${encodeURIComponent(slug)}`,
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
          you want me to audit for this workspace. You can switch later in
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

// ── Step 3b: Pick Meta Ads ad-account (auto-skipped if only 1) ─────
//
// Mirrors AccountStep but for the notfair-metaads MCP. Lands the user
// back on the connect step after picking so they can wire up another
// MCP or finish onboarding.

type MetaListState =
  | { phase: "loading" }
  | { phase: "loaded"; accounts: MetaAdsAccount[]; default_account_id: string | null }
  | { phase: "error"; message: string };

function MetaAccountStep({ slug }: { slug: string }) {
  const router = useRouter();
  const [state, setState] = useState<MetaListState>({ phase: "loading" });
  const [pickingId, setPickingId] = useState<string | null>(null);
  const autoSelectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listMetaAdsAccounts(slug);
      if (cancelled) return;
      if (!result.ok) {
        setState({ phase: "error", message: result.error });
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

  useEffect(() => {
    if (state.phase !== "loaded") return;
    if (state.accounts.length !== 1) return;
    if (autoSelectedRef.current) return;
    autoSelectedRef.current = true;
    (async () => {
      const only = state.accounts[0]!;
      const result = await setOnboardingMetaAdsAccountAction(slug, only.id);
      if (!result.ok) {
        toast.error(result.error);
        setState({ phase: "error", message: result.error });
        return;
      }
      router.replace(
        `/onboarding?step=connect&slug=${encodeURIComponent(slug)}`,
      );
    })();
  }, [state, slug, router]);

  async function onPick(account: MetaAdsAccount) {
    setPickingId(account.id);
    try {
      const result = await setOnboardingMetaAdsAccountAction(slug, account.id);
      if (!result.ok) {
        toast.error(result.error);
        setPickingId(null);
        return;
      }
      router.replace(
        `/onboarding?step=connect&slug=${encodeURIComponent(slug)}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setPickingId(null);
    }
  }

  return (
    <AccountPickerScaffold
      slug={slug}
      mcpDisplayName="Meta Ads"
      idLabel="Ad account ID"
      state={
        state.phase === "loading"
          ? { phase: "loading" }
          : state.phase === "error"
            ? { phase: "error", message: state.message }
            : {
                phase: "loaded",
                items: state.accounts.map((a) => ({
                  id: a.id,
                  name: a.name,
                  isDefault: a.id === state.default_account_id,
                  isPicking: pickingId === a.id,
                })),
                anyPicking: pickingId !== null,
              }
      }
      onPick={(id) => {
        const a = state.phase === "loaded" ? state.accounts.find((x) => x.id === id) : null;
        if (a) onPick(a);
      }}
    />
  );
}

// ── Step 3c: Pick Google Search Console property (auto-skipped if only 1) ──

type GscListState =
  | { phase: "loading" }
  | { phase: "loaded"; properties: GscProperty[]; default_property_id: string | null }
  | { phase: "error"; message: string };

function GscPropertyStep({ slug }: { slug: string }) {
  const router = useRouter();
  const [state, setState] = useState<GscListState>({ phase: "loading" });
  const [pickingId, setPickingId] = useState<string | null>(null);
  const autoSelectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listGscProperties(slug);
      if (cancelled) return;
      if (!result.ok) {
        setState({ phase: "error", message: result.error });
        return;
      }
      setState({
        phase: "loaded",
        properties: result.properties,
        default_property_id: result.default_property_id,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (state.phase !== "loaded") return;
    if (state.properties.length !== 1) return;
    if (autoSelectedRef.current) return;
    autoSelectedRef.current = true;
    (async () => {
      const only = state.properties[0]!;
      const result = await setOnboardingGscPropertyAction(slug, only.id);
      if (!result.ok) {
        toast.error(result.error);
        setState({ phase: "error", message: result.error });
        return;
      }
      router.replace(
        `/onboarding?step=connect&slug=${encodeURIComponent(slug)}`,
      );
    })();
  }, [state, slug, router]);

  async function onPick(property: GscProperty) {
    setPickingId(property.id);
    try {
      const result = await setOnboardingGscPropertyAction(slug, property.id);
      if (!result.ok) {
        toast.error(result.error);
        setPickingId(null);
        return;
      }
      router.replace(
        `/onboarding?step=connect&slug=${encodeURIComponent(slug)}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setPickingId(null);
    }
  }

  return (
    <AccountPickerScaffold
      slug={slug}
      mcpDisplayName="Google Search Console"
      idLabel="Property"
      state={
        state.phase === "loading"
          ? { phase: "loading" }
          : state.phase === "error"
            ? { phase: "error", message: state.message }
            : {
                phase: "loaded",
                items: state.properties.map((p) => ({
                  id: p.id,
                  name: p.name,
                  isDefault: p.id === state.default_property_id,
                  isPicking: pickingId === p.id,
                })),
                anyPicking: pickingId !== null,
              }
      }
      onPick={(id) => {
        const p = state.phase === "loaded" ? state.properties.find((x) => x.id === id) : null;
        if (p) onPick(p);
      }}
    />
  );
}

// ── Shared picker shell for Meta + GSC ─────────────────────────────
//
// Visually identical to the Google Ads picker but parameterized by the
// MCP display label and the id-label shown under each row. Used by
// MetaAccountStep + GscPropertyStep to avoid duplicating ~80 lines of
// loading / error / empty / single-item / picker JSX three times.

type AccountPickerScaffoldState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "loaded";
      items: { id: string; name: string; isDefault: boolean; isPicking: boolean }[];
      anyPicking: boolean;
    };

function AccountPickerScaffold({
  slug,
  mcpDisplayName,
  idLabel,
  state,
  onPick,
}: {
  slug: string;
  mcpDisplayName: string;
  idLabel: string;
  state: AccountPickerScaffoldState;
  onPick: (id: string) => void;
}) {
  if (state.phase === "loading") {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6 pb-6">
          <div className="flex items-center gap-3 text-sm">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            <span className="font-medium">
              Loading your {mcpDisplayName} accounts&hellip;
            </span>
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
              Couldn&rsquo;t load your {mcpDisplayName} accounts.
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{state.message}</p>
          <div className="flex gap-2">
            <Button asChild>
              <Link href={`/onboarding?step=connect&slug=${encodeURIComponent(slug)}`}>
                Back to connect
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (state.items.length === 0) {
    return (
      <Card role="alert">
        <CardContent className="space-y-3 pt-6 pb-6">
          <p className="text-sm font-medium">
            No {mcpDisplayName} accounts on this connection.
          </p>
          <p className="text-xs text-muted-foreground">
            Try a different account or skip this connector for now.
          </p>
          <Button asChild>
            <Link href={`/onboarding?step=connect&slug=${encodeURIComponent(slug)}`}>
              Back to connect
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (state.items.length === 1) {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6 pb-6">
          <div className="flex items-center gap-3 text-sm">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            <span className="font-medium">
              Using your only {mcpDisplayName} account&hellip;
            </span>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Which {mcpDisplayName} account?
        </h1>
        <p className="text-sm text-muted-foreground">
          Your connection has {state.items.length} accounts. Pick the one
          you want me to use for this workspace. You can switch later in
          Settings.
        </p>
      </header>
      <ul className="space-y-2 list-none p-0">
        {state.items.map((item) => {
          const isOtherPicking = state.anyPicking && !item.isPicking;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onPick(item.id)}
                disabled={state.anyPicking}
                aria-label={`Use ${item.name} (${item.id})`}
                className={cn(
                  "block w-full rounded-md border bg-card p-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 disabled:cursor-not-allowed",
                  isOtherPicking && "opacity-50",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{item.name}</span>
                      {item.isDefault && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          default
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {idLabel} {item.id}
                    </p>
                  </div>
                  {item.isPicking ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
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
          This step needs a workspace. Start from the beginning.
        </p>
        <Button asChild>
          <Link href="/onboarding">Start over</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
