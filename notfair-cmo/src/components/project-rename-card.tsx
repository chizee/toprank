"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { slugify } from "@/lib/slug";
import { renameProjectFullAction } from "@/server/actions/projects";

type Props = {
  currentSlug: string;
  currentDisplayName: string;
};

export function ProjectRenameCard({
  currentSlug,
  currentDisplayName,
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
      const r = await renameProjectFullAction({
        current_slug: currentSlug,
        new_display_name: trimmed,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const d = r.data;
      if (d.full_rename) {
        const failed = d.agents_failed.length;
        toast.success(
          failed > 0
            ? `Renamed to "${d.display_name}" (${d.agents_relocated.length} agents moved, ${failed} failed)`
            : `Renamed to "${d.display_name}" (${d.agents_relocated.length} agents moved)`,
        );
      } else {
        toast.success(`Renamed to "${d.display_name}"`);
      }
      router.refresh();
    });
  }

  const canSave =
    !pending && !slugError && trimmed.length > 0 && (nameChanged || slugChanged);

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <Pencil className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Rename this project</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Changing the slug renames every agent in the project, rewrites all
            cron names, moves workspace dirs, relocates session JSONL files,
            and repoints DB rows.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="project-rename-name" className="text-xs">
          Display name
        </Label>
        <input
          id="project-rename-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
          className={cn(
            "h-9 w-full rounded-md border bg-background px-3 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            slugError && "border-destructive focus-visible:ring-destructive",
            pending && "opacity-50",
          )}
          aria-invalid={!!slugError}
        />
        {slugError ? (
          <p className="text-[11px] text-destructive">Invalid name: {slugError}</p>
        ) : slugChanged ? (
          <p className="text-[11px] text-muted-foreground">
            Slug changes from{" "}
            <code className="rounded bg-muted px-1 font-mono">{currentSlug}</code>{" "}
            to{" "}
            <code className="rounded bg-muted px-1 font-mono">{derivedSlug}</code>
            . Every agent will be cloned into the new project and the old one
            removed.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Same slug — only the display name changes.
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={save} disabled={!canSave}>
          {pending ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              {slugChanged ? "Renaming…" : "Saving…"}
            </>
          ) : slugChanged ? (
            "Rename project"
          ) : (
            "Save name"
          )}
        </Button>
      </div>
    </div>
  );
}
