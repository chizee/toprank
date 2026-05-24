"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles, Copy } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  listOpenClawAgentsAction,
  listProjectAgentsAction,
  createAgentAction,
  cloneAgentAction,
  type AgentChoice,
} from "@/server/actions/agents";
import { slugify } from "@/lib/slug";
import { projectHref } from "@/lib/project-href";
import type { CloneAgentResult } from "@/server/openclaw/clone-agent";
import { DisableSourceCronsDialog } from "./disable-source-crons-dialog";

type Mode = "create" | "clone";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active project slug; rendered as the prefix on the new-agent name input. */
  projectSlug: string;
};

export function CreateAgentDialog({ open, onOpenChange, projectSlug }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("create");
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [choices, setChoices] = useState<AgentChoice[]>([]);
  const [loadingChoices, setLoadingChoices] = useState(false);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [projectSlugs, setProjectSlugs] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const [postClone, setPostClone] = useState<{
    result: CloneAgentResult;
    sourceLabel: string;
  } | null>(null);

  useEffect(() => {
    if (!open) {
      setMode("create");
      setName("");
      setSourceId("");
      return;
    }
    setLoadingChoices(true);
    (async () => {
      // Load both: full agent catalog (for the clone dropdown) and the
      // current project's agents (for name-uniqueness validation).
      const [allRes, projectRes] = await Promise.all([
        listOpenClawAgentsAction(),
        listProjectAgentsAction(),
      ]);
      if (allRes.ok) setChoices(allRes.data);
      else setChoicesError(allRes.error);
      if (projectRes.ok) {
        setProjectSlugs(new Set(projectRes.data.map((a) => a.slug)));
      }
      setLoadingChoices(false);
    })();
  }, [open]);

  const selectedSource = choices.find((c) => c.agent_id === sourceId);

  // Compute the slug the typed name would produce so we can validate against
  // existing project agents inline (instead of bouncing through the server).
  const trimmedName = name.trim();
  const slugAttempt = trimmedName ? slugify(trimmedName) : null;
  const derivedSlug = slugAttempt && slugAttempt.ok ? slugAttempt.slug : null;
  const slugInvalidReason =
    slugAttempt && !slugAttempt.ok ? slugAttempt.reason : null;
  const nameCollision = !!derivedSlug && projectSlugs.has(derivedSlug);

  function onSubmit() {
    if (mode === "create") {
      if (!name.trim()) {
        toast.error("Please enter an agent name.");
        return;
      }
      startTransition(async () => {
        const r = await createAgentAction({ display_name: name.trim() });
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        toast.success(`Created ${name.trim()}`);
        onOpenChange(false);
        router.push(projectHref(projectSlug, `/agents/${r.data.slug}/chat`));
        router.refresh();
      });
      return;
    }
    // Clone mode
    if (!sourceId) {
      toast.error("Please pick a source agent.");
      return;
    }
    const displayName = name.trim();
    if (!displayName) {
      toast.error("Please give the cloned agent a name.");
      return;
    }
    startTransition(async () => {
      const r = await cloneAgentAction({
        source_agent_id: sourceId,
        new_display_name: displayName,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(
        `Cloned ${selectedSource?.display_name ?? sourceId} → ${displayName}`,
      );
      onOpenChange(false);
      // Surface the disable-source-crons follow-up if there were any.
      if (r.data.source_crons.length > 0) {
        setPostClone({ result: r.data, sourceLabel: selectedSource?.display_name ?? sourceId });
      } else {
        // Send the user straight into the new agent.
        router.push(projectHref(projectSlug, `/agents/${r.data.new_slug}/chat`));
      }
      router.refresh();
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>
              Add a fresh agent to this project, or clone one of your existing OpenClaw agents.
            </DialogDescription>
          </DialogHeader>

          <div
            className="inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1"
            role="tablist"
          >
            <ModeButton
              active={mode === "create"}
              onClick={() => setMode("create")}
              icon={<Sparkles className="size-3.5" />}
              label="Create new"
            />
            <ModeButton
              active={mode === "clone"}
              onClick={() => setMode("clone")}
              icon={<Copy className="size-3.5" />}
              label="Clone existing"
            />
          </div>

          {mode === "create" ? (
            <div className="space-y-2">
              <Label htmlFor="new-agent-name">Agent name</Label>
              <PrefixedInput
                id="new-agent-name"
                prefix={`${projectSlug}-`}
                placeholder="content-writer"
                value={name}
                onChange={setName}
                disabled={pending}
                autoFocus
                invalid={nameCollision || !!slugInvalidReason}
              />
              <NameHint
                derivedSlug={derivedSlug}
                collision={nameCollision}
                invalidReason={slugInvalidReason}
                defaultHint="Becomes the URL slug too (lowercased, hyphenated)."
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="clone-source">Source agent</Label>
                {loadingChoices ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> Loading agents…
                  </div>
                ) : choicesError ? (
                  <div className="text-xs text-destructive">{choicesError}</div>
                ) : (
                  <select
                    id="clone-source"
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                    disabled={pending}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Pick one…</option>
                    {choices.map((c) => (
                      <option key={c.agent_id} value={c.agent_id}>
                        {c.display_name}
                        {c.display_name !== c.agent_id ? `  ·  ${c.agent_id}` : ""}
                        {c.in_current_project ? "  (in this project)" : ""}
                      </option>
                    ))}
                  </select>
                )}
                {selectedSource && (
                  <p className="text-[11px] text-muted-foreground">
                    Copies workspace files, chat threads, and cron jobs. Cron jobs will be
                    renamed to match this project.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="clone-name">
                  New agent name <span className="text-destructive">*</span>
                </Label>
                <PrefixedInput
                  id="clone-name"
                  prefix={`${projectSlug}-`}
                  placeholder="supa-backup"
                  value={name}
                  onChange={setName}
                  disabled={pending}
                  invalid={nameCollision || !!slugInvalidReason}
                />
                <NameHint
                  derivedSlug={derivedSlug}
                  collision={nameCollision}
                  invalidReason={slugInvalidReason}
                  defaultHint="Must be unique within this project."
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={onSubmit}
              disabled={
                pending ||
                nameCollision ||
                !!slugInvalidReason ||
                (mode === "create" && !name.trim()) ||
                (mode === "clone" && (!sourceId || !name.trim()))
              }
            >
              {pending ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  {mode === "clone" ? "Cloning…" : "Creating…"}
                </>
              ) : mode === "clone" ? (
                "Clone agent"
              ) : (
                "Create agent"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {postClone && (
        <DisableSourceCronsDialog
          open
          onOpenChange={(o) => !o && setPostClone(null)}
          sourceLabel={postClone.sourceLabel}
          newAgentId={postClone.result.new_agent_id}
          sourceCrons={postClone.result.source_crons}
          onDone={() => {
            router.push(
              projectHref(projectSlug, `/agents/${postClone.result.new_slug}/chat`),
            );
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function PrefixedInput({
  id,
  prefix,
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus,
  invalid,
}: {
  id: string;
  prefix: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-9 items-stretch overflow-hidden rounded-md border bg-background text-sm shadow-sm focus-within:ring-1 focus-within:ring-ring",
        invalid && "border-destructive focus-within:ring-destructive",
        disabled && "opacity-50",
      )}
    >
      <span
        className="select-none border-r bg-muted/50 px-2.5 font-mono text-[12px] text-muted-foreground flex items-center"
        aria-hidden
      >
        {prefix}
      </span>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        className="flex-1 bg-transparent px-2 font-mono text-[13px] placeholder:text-muted-foreground/60 focus-visible:outline-none disabled:cursor-not-allowed"
      />
    </div>
  );
}

function NameHint({
  derivedSlug,
  collision,
  invalidReason,
  defaultHint,
}: {
  derivedSlug: string | null;
  collision: boolean;
  invalidReason: string | null;
  defaultHint: string;
}) {
  if (invalidReason) {
    return (
      <p className="text-[11px] text-destructive">
        Invalid name: {invalidReason}
      </p>
    );
  }
  if (collision && derivedSlug) {
    return (
      <p className="text-[11px] text-destructive">
        An agent named &ldquo;{derivedSlug}&rdquo; already exists in this project.
        Pick a different name.
      </p>
    );
  }
  return <p className="text-[11px] text-muted-foreground">{defaultHint}</p>;
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
