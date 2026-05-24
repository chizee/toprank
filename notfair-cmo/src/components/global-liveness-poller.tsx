"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Lives in the app sidebar (rendered on every route), so the sidebar's
 * per-agent live-task badges + the per-page task list groups stay fresh
 * no matter where the user is sitting — /home, /approvals, /tasks, an
 * agent workspace, etc. — while something is in flight somewhere.
 *
 * Replaces the workspace-scoped AgentLivenessPoller. Same idea, just
 * lifted to the layout level so non-workspace pages don't go stale.
 *
 * Strategy: poll a small JSON endpoint at /api/in-flight-counts, hash
 * the response, and ONLY call router.refresh() when the hash differs
 * from the previous one. Calling router.refresh() unconditionally on
 * every tick re-renders the whole sidebar subtree which made it
 * visibly blink even when nothing changed. With the signature gate,
 * steady-state polling is silent.
 *
 * Cadence: 2 s while `hasInFlight` is true. The first refresh that lands
 * a server-rendered `hasInFlight = false` flips the prop, the effect
 * tears the interval down, and we stop spending requests on idle state.
 */
export function GlobalLivenessPoller({ hasInFlight }: { hasInFlight: boolean }) {
  const router = useRouter();
  const lastSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hasInFlight) return;
    let cancelled = false;

    async function tick() {
      try {
        const r = await fetch("/api/in-flight-counts", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!r.ok) return;
        const body = (await r.json()) as {
          project: string | null;
          agents: Record<string, number>;
          approvals: number;
        };
        // Canonical signature: same shape ⇒ same string. Sort the agent
        // keys so map-iteration order doesn't generate a false-positive.
        const sig = JSON.stringify({
          p: body.project,
          a: Object.entries(body.agents)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, v]),
          v: body.approvals,
        });
        if (cancelled) return;
        if (lastSignatureRef.current !== null && lastSignatureRef.current !== sig) {
          router.refresh();
        }
        lastSignatureRef.current = sig;
      } catch {
        // Network/JSON hiccup — skip this tick; we'll catch up next.
      }
    }
    // Seed the signature on mount so the first real change triggers
    // a refresh (otherwise the very first tick would always refresh).
    void tick();
    const interval = setInterval(tick, 2_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [hasInFlight, router]);
  return null;
}
