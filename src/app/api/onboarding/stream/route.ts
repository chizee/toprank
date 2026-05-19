import { NextRequest } from "next/server";

import { getActiveProject } from "@/server/active-project";
import { getProject } from "@/server/db/projects";
import { runAudit } from "@/server/onboarding/audit";
import { awaitProvisioning } from "@/server/onboarding/provisioning-state";
import type { StreamEvent } from "@/lib/onboarding/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE stream powering the onboarding magic moment.
 *
 * Phases (per D13 + D17):
 *   1. Provisioning gate — await `ensureProjectAgents` (fired async by
 *      createProjectAction) for up to 8s. Emits provision:waiting →
 *      provision:ready | provision:timeout | provision:no-agents.
 *   2. Audit — pipe `runAudit` events to the client with ~200ms stagger
 *      between per-finding events for visual rhythm.
 *
 * Security (per design Pass 3.3): the slug query param MUST match the
 * active-project cookie. Otherwise the caller could read another project's
 * audit by guessing slugs.
 *
 * Cancellation: when the client closes the EventSource, req.signal fires;
 * we cascade to runAudit's AbortSignal so the in-flight MCP fetch cancels.
 */

const PROVISION_TIMEOUT_MS = 8_000;
const FINDING_STAGGER_MS = 200;

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug")?.trim() || "";
  const active = await getActiveProject();
  if (!slug || !active || active.slug !== slug) {
    return new Response("forbidden", { status: 403 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: StreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Controller closed underneath us (client disconnected mid-flight).
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      const abortAudit = new AbortController();
      const onClientAbort = () => abortAudit.abort();
      req.signal.addEventListener("abort", onClientAbort, { once: true });

      try {
        // Phase 1: provisioning gate.
        send({ type: "provision:waiting", elapsed_ms: 0 });
        const provision = await awaitProvisioning(slug, PROVISION_TIMEOUT_MS);
        if (closed) return;
        if (provision.kind === "timeout") {
          send({ type: "provision:timeout" });
          close();
          return;
        }
        if (provision.kind === "no-agents") {
          send({ type: "provision:no-agents" });
          close();
          return;
        }
        send({ type: "provision:ready" });

        // Phase 2: stream audit events. Pass the user's selected Google Ads
        // account ID so MCP runScript targets the right customer; null when
        // the user hasn't picked yet (single-account bearer case).
        const project = getProject(slug);
        const accountId = project?.google_ads_account_id ?? null;
        for await (const event of runAudit(slug, abortAudit.signal, {
          accountId,
        })) {
          if (closed) break;
          send(event);
          if (event.type === "audit:finding") {
            // Small stagger so per-finding cards land with rhythm in the UI.
            await new Promise((r) => setTimeout(r, FINDING_STAGGER_MS));
          }
        }
      } catch (err) {
        if (!closed) {
          send({
            type: "audit:error",
            kind: "unreachable",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        req.signal.removeEventListener("abort", onClientAbort);
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
