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
import { AgentChat } from "@/components/agent-chat";
import { ThreadSelector } from "@/components/thread-selector";

type Params = { agent: string; thread: string };

export default async function AgentChatThreadPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { agent: agentSlug, thread: threadId } = await params;

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
            <Link href="/projects/new" className="text-sm underline">
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

  return (
    <div className="flex h-full flex-col">
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
