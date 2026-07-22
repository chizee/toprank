"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type VersionInfo = {
  current: string;
  latest: string | null;
  has_update: boolean;
};

type Phase =
  | "idle"
  | "downloading"
  | "ready"
  | "restarting"
  | "manual"
  | "failed";

/**
 * Sidebar footer: current version + the update flow. When npm reports a
 * newer version, it installs automatically through /api/upgrade. Once ready,
 * the Update button restarts background/launchd servers through /api/restart
 * and reloads on the new version. Foreground/dev runs are told to restart
 * from the terminal because the app does not own those processes.
 */
export function SidebarVersion() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const autoDownloadVersion = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/version", { cache: "no-store" })
      .then((r) => r.json() as Promise<VersionInfo>)
      .then((v) => {
        if (!cancelled) setInfo(v);
      })
      .catch(() => {
        // Offline / blocked — keep the bar empty rather than spam errors.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!info?.has_update || !info.latest) return;
    if (autoDownloadVersion.current === info.latest) return;
    autoDownloadVersion.current = info.latest;
    void downloadUpdate(info);
  }, [info]);

  async function downloadUpdate(version: VersionInfo) {
    if (!version.has_update) return;
    setPhase("downloading");
    try {
      const res = await fetch("/api/upgrade", { method: "POST" });
      const body = (await res.json()) as
        | { ok: true; note?: string; can_restart?: boolean }
        | { ok: false; error?: string; command?: string; hint?: string };
      if (!res.ok || !body.ok) {
        const msg = !body.ok
          ? body.hint ?? body.error ?? "Upgrade failed"
          : "Upgrade failed";
        if (!body.ok && body.command) {
          await navigator.clipboard.writeText(body.command).catch(() => {});
          toast.error(`${msg}\nCommand copied to clipboard.`, { duration: 10_000 });
        } else {
          toast.error(msg, { duration: 8_000 });
        }
        setPhase("failed");
        return;
      }
      if (body.can_restart) {
        setPhase("ready");
        toast.success(`v${version.latest} installed — click Update to apply.`, {
          duration: 10_000,
        });
      } else {
        setPhase("manual");
        toast.success(
          body.note ?? "Upgraded. Restart NotFair in your terminal to apply.",
          { duration: 15_000 },
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setPhase("failed");
    }
  }

  async function restart() {
    if (phase !== "ready") return;
    setPhase("restarting");
    try {
      const res = await fetch("/api/restart", { method: "POST" });
      const body = (await res.json()) as { ok: boolean; hint?: string };
      if (!res.ok || !body.ok) {
        toast.error(body.hint ?? "Could not restart from here — use your terminal.", {
          duration: 10_000,
        });
        setPhase("manual");
        return;
      }
    } catch {
      // The server may die mid-response — that's the restart happening.
    }
    // Poll until the new version answers, then hard-reload so the client
    // bundle matches the server again.
    const target = info?.latest ?? null;
    const deadline = Date.now() + 60_000;
    const poll = async () => {
      try {
        const v = (await (
          await fetch("/api/version", { cache: "no-store" })
        ).json()) as VersionInfo;
        if (!target || v.current === target) {
          window.location.reload();
          return;
        }
      } catch {
        // Still down — keep waiting.
      }
      if (Date.now() < deadline) {
        setTimeout(poll, 1_500);
      } else {
        toast.error("The server hasn't come back yet — check `notfair status`.", {
          duration: 10_000,
        });
        setPhase("manual");
      }
    };
    setTimeout(poll, 2_000);
  }

  if (!info) {
    return (
      <div className="px-1 text-[11px] font-mono text-[hsl(var(--notfair-ink-4))]">
        NotFair
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 px-1 text-[11px]">
      <span className="font-mono text-[hsl(var(--notfair-ink-4))]">
        NotFair v{info.current}
      </span>

      {info.has_update && (phase === "idle" || phase === "downloading") && (
        <Button
          size="sm"
          variant="outline"
          disabled
          title={`Downloading update v${info.latest}`}
          className="h-6 gap-1 px-2 text-[10.5px] font-medium"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          Downloading…
        </Button>
      )}

      {phase === "failed" && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void downloadUpdate(info)}
          title={`Retry update v${info.latest}`}
          className="h-6 gap-1 px-2 text-[10.5px] font-medium"
        >
          <Sparkles className="h-3 w-3" />
          Retry update
        </Button>
      )}

      {(phase === "ready" || phase === "restarting") && (
        <Button
          size="sm"
          variant="outline"
          disabled={phase === "restarting"}
          onClick={restart}
          title={`Restart and update to v${info.latest}`}
          className="h-6 gap-1 px-2 text-[10.5px] font-medium"
        >
          {phase === "restarting" ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Restarting…
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3" />
              Update to v{info.latest}
            </>
          )}
        </Button>
      )}

      {phase === "manual" && (
        <span className="text-[10.5px] text-[hsl(var(--notfair-accent))]">
          Restart to apply
        </span>
      )}
    </div>
  );
}
