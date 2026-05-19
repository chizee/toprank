import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getActiveProject } from "@/server/active-project";
import { resolveAgentBySlug } from "@/server/agent-meta";
import {
  buildPendingSessionKey,
  findSessionBySessionId,
  listSessionsForAgent,
  loadSessionHistory,
} from "@/server/openclaw/sessions";
import { storedMcpKey } from "@/server/mcp-catalog";
import { getMcpStatus } from "@/server/mcp-state";
import { AgentChat } from "@/components/agent-chat";
import { GoogleAdsMcpBanner } from "@/components/google-ads-mcp-banner";
import { McpFlashBanner } from "@/components/mcp-flash-banner";
import { ThreadSelector } from "@/components/thread-selector";

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

  // Either we have a known session (use its registered sessionKey) or this is
  // a brand-new thread the user just navigated into; use a self-named key so
  // OpenClaw can create the entry on the first turn.
  const sessionKey = existing?.sessionKey ?? buildPendingSessionKey(agentFullId, threadId);
  // History lives in a JSONL file named after OpenClaw's internal sessionId,
  // which is distinct from the URL thread id (the label half of the sessionKey).
  const history = existing ? loadSessionHistory(agentFullId, existing.sessionId) : [];

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
        <AgentChat
          key={threadId}
          projectSlug={project.slug}
          agentSlug={agentSlug}
          agentDisplayName={resolved.display_name}
          sessionId={threadId}
          sessionKey={sessionKey}
          templateKey={resolved.template_key}
          initialMessages={history.map((m) => ({ id: m.id, role: m.role, body: m.body }))}
        />
      </div>
    </div>
  );
}
