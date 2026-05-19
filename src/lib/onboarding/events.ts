/**
 * Streamed event types for /api/onboarding/stream. Shared between the SSE
 * route handler and the onboarding UI. AuditEvent comes from the server-side
 * audit module; ProvisionEvent is local to this flow.
 *
 * Why a type-only re-export: audit.ts pulls in node:fs/promises + openclaw
 * subprocess + better-sqlite3 (server-only). Importing the TYPE only from
 * the client bundle is safe because `import type` is erased at compile time.
 */

import type { AuditEvent, Finding, FindingCategory, AuditSummary } from "@/server/onboarding/audit";

export type ProvisionEvent =
  | { type: "provision:waiting"; elapsed_ms: number }
  | { type: "provision:ready" }
  | { type: "provision:timeout" }
  | { type: "provision:no-agents" };

export type StreamEvent = ProvisionEvent | AuditEvent;

export type { AuditEvent, Finding, FindingCategory, AuditSummary };
