import Link from "next/link";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { projectHref } from "@/lib/project-href";
import type { AgentMcpBlocker } from "@/server/onboarding/agent-mcp-blocker";

/**
 * Card rendered in place of the agent's chat/tasks UI when the agent's
 * template requires an MCP that isn't connected for this project. Server-
 * rendered — no client state. The "Connect now" button is just a link
 * into the Connections page where the existing OAuth flow takes over.
 */
export function AgentMcpBlockerCard({
  projectSlug,
  blocker,
}: {
  projectSlug: string;
  blocker: AgentMcpBlocker;
}) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Plug className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <h1 className="mt-4 text-lg font-semibold tracking-tight">
        Connect {blocker.mcp_display_name} to use this agent
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The {blocker.agent_display_name} agent needs the{" "}
        {blocker.mcp_display_name} MCP before it can run. Connecting takes a
        single OAuth round-trip; we&rsquo;ll bring you back here when
        it&rsquo;s done.
      </p>
      <Button asChild className="mt-6">
        <Link href={projectHref(projectSlug, "/connections")}>
          Connect {blocker.mcp_display_name}
        </Link>
      </Button>
    </div>
  );
}
