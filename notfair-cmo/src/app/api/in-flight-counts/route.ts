import { NextResponse } from "next/server";

import { getActiveProject } from "@/server/active-project";
import { actionableApprovalCount } from "@/server/db/approvals";
import { inFlightCountsByAgent } from "@/server/db/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Lightweight liveness probe used by GlobalLivenessPoller to decide
 * whether the sidebar actually needs a refresh. The poller fetches this
 * a few times a minute; only when the response signature differs from
 * the previous one does it call router.refresh(). That stops the
 * sidebar from blinking on every poll cycle when nothing has changed.
 */
export async function GET() {
  const project = await getActiveProject();
  if (!project) {
    return NextResponse.json({ project: null, agents: {}, approvals: 0 });
  }
  const countsMap = inFlightCountsByAgent(project.slug);
  const agents: Record<string, number> = {};
  for (const [agentId, count] of countsMap) agents[agentId] = count;
  const approvals = actionableApprovalCount(project.slug);
  return NextResponse.json({ project: project.slug, agents, approvals });
}
