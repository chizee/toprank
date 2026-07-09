import { notFound } from "next/navigation";
import { getProject } from "@/server/db/projects";
import { DEFAULT_HARNESS_ADAPTER, requireAdapter } from "@/server/adapters/registry";
import { resolveAgentBySlug } from "@/server/agent-meta";
import {
  buildPendingSessionKey,
  findSessionBySessionId,
  listSessionsForAgent,
} from "@/server/sessions/view";
import { classifySessions } from "@/server/sessions/view";
import { getMcpStatus } from "@/server/mcp/state";
import { getMcpCatalog } from "@/server/mcp-catalog";
import { readTranscriptTail } from "@/server/sessions/transcript-tail";
import { LiveTranscript } from "@/components/live-transcript";
import { GoogleAdsMcpBanner } from "@/components/google-ads-mcp-banner";
import { McpFlashBanner } from "@/components/mcp-flash-banner";
import { ChatThreadRail, type SessionLite } from "@/components/chat-thread-rail";

type Params = { agent: string; thread: string; project: string };
type Search = { mcp_connected?: string; mcp_error?: string };

export default async function AgentChatThreadPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { agent: agentSlug, thread: threadId, project: projectSlug } = await params;
  const { mcp_connected, mcp_error } = await searchParams;

  const project = getProject(projectSlug);
  if (!project || project.archived_at) notFound();

  const resolved = await resolveAgentBySlug(project.slug, agentSlug);
  if (!resolved) notFound();
  const agentFullId = resolved.agent_id;
  const allSessions = listSessionsForAgent(project.slug, agentFullId);
  const existing = findSessionBySessionId(project.slug, agentFullId, threadId);

  // sessionKey is now just the label string (the notfair-cmo `sessions.id`
  // is opaque to the UI; the label drives URLs + transcript lookups).
  const sessionKey =
    existing?.sessionKey ?? buildPendingSessionKey(agentFullId, threadId);
  const { events: initialEvents, byteOffset: initialByteOffset } =
    readTranscriptTail(project.slug, agentFullId, threadId, 0);

  // Classify existing sessions by origin (task / cron / chat) so the
  // dropdown can show the task display_id, cron name, or first-message
  // preview instead of opaque UUIDs.
  const origins = await classifySessions(agentFullId, project.slug, allSessions);
  const enriched: SessionLite[] = allSessions.map((s) => ({
    sessionId: s.sessionId,
    label: s.label,
    sessionKey: s.sessionKey,
    lastInteractionAt: s.lastInteractionAt,
    pending: s.pending,
    title: s.title,
    pinned: s.pinned,
    origin: origins.get(s.label),
  }));

  // For the rail: surface the pending thread at the top so the user sees
  // it's "selected" even before sending the first message.
  const sessionsForRail: SessionLite[] = existing
    ? enriched
    : [
        {
          sessionId: threadId,
          label: threadId.slice(0, 8),
          sessionKey,
          lastInteractionAt: 0,
          pending: true,
        },
        ...enriched,
      ];

  // The Google Ads agent depends on the notfair-googleads MCP for live
  // account operations. When it isn't connected yet (or the token is stale),
  // surface a banner so the user can fix it in one click without leaving
  // the chat. Probe runs server-side with its own 2s timeout — same as the
  // Connections page — so a slow upstream can't gate the chat render.
  const googleAdsMcpStatus =
    resolved.template_key === "google_ads"
      ? await getMcpStatus(project.slug, "notfair-googleads")
      : null;

  // Free-form chat never auto-kickoffs. Task-driven kickoffs happen in the
  // task workspace's startTaskIfProposed path; the FIRST_TURN.md sentinel
  // from the old onboarding audit is gone now that audit IS a task.
  const autoKickoff = false;

  // MCP catalog — pass through the minimum shape the chat needs to
  // render an MCP server's brand favicon next to its tool calls.
  // Mapping is by server key, so the resource_url is the brand domain
  // we feed faviconV2.
  // Provider-fed model list for the composer's selector (codex reads its
  // account-scoped cache; claude uses its documented tier aliases).
  const modelOptions = await requireAdapter(
    project.harness_adapter ?? DEFAULT_HARNESS_ADAPTER,
  ).listModels();
  const mcpCatalog = getMcpCatalog(project.slug).map((m) => ({
    key: m.key,
    display_name: m.display_name,
    resource_url: m.resource_url,
  }));

  return (
    <div className="flex h-full flex-col">
      <McpFlashBanner connected={mcp_connected} error={mcp_error} />

      {googleAdsMcpStatus && googleAdsMcpStatus.state !== "connected" && (
        <GoogleAdsMcpBanner status={googleAdsMcpStatus} projectSlug={projectSlug} />
      )}

      {/* Same two-pane shape as the task workspace: thread rail on the
          left (New chat on top), live transcript on the right. */}
      <div className="flex min-h-0 flex-1">
        <ChatThreadRail
          projectSlug={projectSlug}
          agentSlug={agentSlug}
          sessions={sessionsForRail}
          activeSessionId={threadId}
        />
        <section className="flex min-w-0 flex-1 flex-col">
          <LiveTranscript
            key={threadId}
            projectSlug={projectSlug}
            agentSlug={agentSlug}
            agentDisplayName={resolved.name}
            threadId={threadId}
            sessionKey={sessionKey}
            initialEvents={initialEvents}
            initialByteOffset={initialByteOffset}
            autoKickoff={autoKickoff}
            mcpCatalog={mcpCatalog}
            modelOptions={modelOptions}
          />
        </section>
      </div>
    </div>
  );
}
