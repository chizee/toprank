"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { slugify } from "@/lib/slug";
import { projectHref } from "@/lib/project-href";
import { renameAgentAction } from "@/server/actions/agents";

type Props = {
  agentId: string;
  projectSlug: string;
  currentDisplayName: string;
  currentSlug: string;
};

export function AgentRenameCard({
  agentId,
  projectSlug,
  currentDisplayName,
  currentSlug,
}: Props) {
  const router = useRouter();
  const [name, setName] = useState(currentDisplayName);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setName(currentDisplayName);
  }, [currentDisplayName]);

  const trimmed = name.trim();
  const slugAttempt = trimmed ? slugify(trimmed) : null;
  const derivedSlug = slugAttempt?.ok ? slugAttempt.slug : null;
  const slugError = slugAttempt && !slugAttempt.ok ? slugAttempt.reason : null;
  const slugChanged = !!derivedSlug && derivedSlug !== currentSlug;
  const nameChanged = trimmed !== currentDisplayName;

  function save() {
    if (!nameChanged && !slugChanged) return;
    startTransition(async () => {
      const r = await renameAgentAction({
        agent_id: agentId,
        new_display_name: trimmed,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const d = r.data;
      toast.success(
        d.full_rename
          ? `Renamed to "${d.display_name}" (new URL: ${projectHref(projectSlug, `/agents/${d.slug}`)})`
          : `Renamed to "${d.display_name}"`,
      );
      if (d.full_rename) {
        // agent_id and URL slug changed — route to the new settings page.
        router.push(projectHref(projectSlug, `/agents/${d.slug}/settings`));
        router.refresh();
      } else {
        router.refresh();
      }
    });
  }

  const canSave =
    !pending && !slugError && trimmed.length > 0 && (nameChanged || slugChanged);

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <Pencil className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Rename this agent</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Changing the slug rewrites the URL, workspace path, sessions
            location, and every cron name. Chat history and prompts come along.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="rename-display-name" className="text-xs">
          Display name
        </Label>
        <div
          className={cn(
            "flex h-9 items-stretch overflow-hidden rounded-md border bg-background text-sm shadow-sm focus-within:ring-1 focus-within:ring-ring",
            slugError && "border-destructive focus-within:ring-destructive",
            pending && "opacity-50",
          )}
        >
          <span
            className="flex select-none items-center border-r bg-muted/50 px-2.5 font-mono text-[12px] text-muted-foreground"
            aria-hidden
          >
            {projectSlug}-
          </span>
          <input
            id="rename-display-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            className="flex-1 bg-transparent px-2 font-mono text-[13px] placeholder:text-muted-foreground/60 focus-visible:outline-none disabled:cursor-not-allowed"
            placeholder={currentSlug}
            aria-invalid={!!slugError}
          />
        </div>
        {slugError ? (
          <p className="text-[11px] text-destructive">Invalid name: {slugError}</p>
        ) : slugChanged ? (
          <p className="text-[11px] text-muted-foreground">
            Slug changes from{" "}
            <code className="rounded bg-muted px-1 font-mono">{currentSlug}</code>{" "}
            to{" "}
            <code className="rounded bg-muted px-1 font-mono">{derivedSlug}</code>
            . Full rename: clones into the new id, then deletes the old.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Same slug — only the display name changes.
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={!canSave}
        >
          {pending ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              {slugChanged ? "Renaming…" : "Saving…"}
            </>
          ) : slugChanged ? (
            "Rename agent"
          ) : (
            "Save name"
          )}
        </Button>
      </div>
    </div>
  );
}
