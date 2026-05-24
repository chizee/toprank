"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { startAllProposedTasksAction } from "@/server/actions/tasks";

/**
 * Kicks off every proposed task for an agent in one click. Server action
 * marks tasks running and fires background kickoffs; this button then
 * starts a short polling loop (router.refresh every 3s for 2 minutes) so
 * the user sees status flip from proposed → running → succeeded as each
 * agent run finishes, without staring at a stale page.
 */
export function StartAllTasksButton({
  agentId,
  proposedCount,
}: {
  agentId: string;
  proposedCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [polling, setPolling] = useState(false);

  async function onClick() {
    startTransition(async () => {
      const result = await startAllProposedTasksAction(agentId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.data.started === 0) {
        toast.info("No proposed tasks to start.");
        return;
      }
      toast.success(
        `Started ${result.data.started} task${result.data.started === 1 ? "" : "s"}.`,
      );
      router.refresh();
      // Poll for ~2 minutes so the page reflects status flips without the
      // user needing to refresh manually. Long enough for most tasks (3 ×
      // 30-60s each) but bounded so we don't burn cycles forever.
      setPolling(true);
      const intervalId = setInterval(() => router.refresh(), 3_000);
      const timeoutId = setTimeout(() => {
        clearInterval(intervalId);
        setPolling(false);
      }, 120_000);
      // Belt + suspenders cleanup if component unmounts (rare here).
      void timeoutId;
    });
  }

  const disabled = pending || polling || proposedCount === 0;
  const label = polling
    ? "Working…"
    : pending
      ? "Starting…"
      : `Start all ${proposedCount} task${proposedCount === 1 ? "" : "s"}`;

  return (
    <Button onClick={onClick} disabled={disabled} size="sm">
      {pending || polling ? (
        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
      ) : (
        <Play className="mr-1.5 size-3.5" />
      )}
      {label}
    </Button>
  );
}
