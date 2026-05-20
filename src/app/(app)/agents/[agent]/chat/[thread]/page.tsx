import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getActiveProject } from "@/server/active-project";
import { resolveAgentBySlug } from "@/server/agent-meta";
import {
  buildPendingSessionKey,
  findSessionBySessionId,
  listSessionsForAgent,
} from "@/server/openclaw/sessions";
import { storedMcpKey } from "@/server/mcp-catalog";
import { getMcpStatus } from "@/server/mcp-state";
import { readTranscriptTail } from "@/server/openclaw/transcript-tail";
import { LiveTranscript } from "@/components/live-transcript";
import { GoogleAdsMcpBanner } from "@/components/google-ads-mcp-banner";
import { McpFlashBanner } from "@/components/mcp-flash-banner";
import { ThreadSelector } from "@/components/thread-selector";

/**
 * The onboarding audit module drops FIRST_TURN.md in the CMO's workspace so
 * the agent can weave the audit into its opening greeting (per D19). But the
 * chat client doesn't run the agent until the user types — so without this
 * gate the user lands on a silent empty chat. Detect server-side: when the
 * thread has no history AND FIRST_TURN.md exists, signal the client to
 * auto-send a hidden kickoff so the agent produces its opener.
 */
function firstTurnPendingForAgent(agentId: string): boolean {
  const dataDir = process.env.NOTFAIR_CMO_DATA_DIR ?? join(homedir(), ".notfair-cmo");
  return existsSync(join(dataDir, "agents", agentId, "FIRST_TURN.md"));
}

type Params = { agent: string; thread: string };
type Search = { mcp_connected?: string; mcp_error?: string };

export default async function AgentChatThreadPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { agent: agentSlug, thread: threadId } = await params;
  const { mcp_connected, mcp_error } = await searchParams;

  const project = await getActiveProject();
  if (!project) {
    return (
      <div className="mx-auto max-w-md p-6 pt-12">
        <Card>
          <CardHeader>
            <CardTitle>No active project</CardTitle>
            <CardDescription>
              Create a project before chatting with this agent.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/onboarding" className="text-sm underline">
              Create one
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const resolved = await resolveAgentBySlug(project.slug, agentSlug);
  if (!resolved) notFound();
  const agentFullId = resolved.agent_id;
  const allSessions = listSessionsForAgent(agentFullId);
  const existing = findSessionBySessionId(agentFullId, threadId);

  // Pull the full transcript slice (text, tool calls, tool results) so the
  // chat page renders the same rich JSONL view the task workspace shows.
  // The sessionKey comes from OpenClaw's index when the thread already
  // exists; pending threads get a derived key tied to the URL threadId.
  const sessionKey =
    existing?.sessionKey ?? buildPendingSessionKey(agentFullId, threadId);
  const { events: initialEvents, byteOffset: initialByteOffset } =
    readTranscriptTail(agentFullId, threadId, 0);

  // For the dropdown: surface the pending thread at the top so the user sees
  // it's "selected" even before sending the first message.
  const sessionsForDropdown = existing
    ? allSessions
    : [
        {
          sessionId: threadId,
          label: threadId.slice(0, 8),
          sessionKey,
          lastInteractionAt: 0,
          pending: true,
        },
        ...allSessions,
      ];

  // The Google Ads agent depends on the notfair-googleads MCP for live
  // account operations. When it isn't connected yet (or the token is stale),
  // surface a banner so the user can fix it in one click without leaving
  // the chat. Probe runs server-side with its own 2s timeout — same as the
  // Connections page — so a slow upstream can't gate the chat render.
  const googleAdsMcpStatus =
    resolved.template_key === "google_ads"
      ? await getMcpStatus(storedMcpKey(project.slug, "notfair-googleads"))
      : null;

  // Auto-kickoff: only on a brand-new thread for an agent with a FIRST_TURN.md
  // sentinel (dropped by the onboarding audit). The agent's system prompt
  // tells it to read the file + move it to MEMORY/ after, so subsequent
  // sessions won't re-fire even though we keep the simple history-empty check.
  const autoKickoff =
    initialEvents.length === 0 && firstTurnPendingForAgent(agentFullId);

  return (
    <div className="flex h-full flex-col">
      <McpFlashBanner connected={mcp_connected} error={mcp_error} />

      {googleAdsMcpStatus && googleAdsMcpStatus.state !== "connected" && (
        <GoogleAdsMcpBanner status={googleAdsMcpStatus} />
      )}

      <div className="flex items-center justify-between border-b bg-background/80 px-6 py-2 backdrop-blur">
        <div className="text-xs text-muted-foreground">
          {sessionsForDropdown.length === 0
            ? "No threads yet"
            : `${sessionsForDropdown.length} thread${sessionsForDropdown.length === 1 ? "" : "s"}`}
        </div>
        <ThreadSelector
          agentSlug={agentSlug}
          sessions={sessionsForDropdown}
          activeSessionId={threadId}
        />
      </div>

      <div className="min-h-0 flex-1">
        <LiveTranscript
          key={threadId}
          agentSlug={agentSlug}
          agentDisplayName={resolved.display_name}
          threadId={threadId}
          sessionKey={sessionKey}
          initialEvents={initialEvents}
          initialByteOffset={initialByteOffset}
          autoKickoff={autoKickoff}
        />
      </div>
    </div>
  );
}
