"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Briefcase, Megaphone, Search, type LucideIcon } from "lucide-react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { RunningDot } from "@/components/running-dot";
import type { AgentTemplateKey } from "@/server/agent-templates";
import { colorForRole } from "@/lib/agent-colors";
import { cn } from "@/lib/utils";
import { projectHref } from "@/lib/project-href";

type AgentNavEntry = {
  /** Stable key for React, e.g. the agent_id. */
  key: string;
  slug: string;
  /** Personal name shown as the primary sidebar label (e.g. "Greg"). */
  name: string;
  /** Role label for the pill next to the name (e.g. "CMO"). Undefined for
   *  cloned/custom agents that aren't backed by a template. */
  role_label?: string;
  description?: string;
  /** Filled for template agents; undefined for cloned/custom ones. */
  template_key?: AgentTemplateKey;
};

type Props = {
  projectSlug: string;
  agents: AgentNavEntry[];
  /**
   * agent_id → in-flight task count. Drives the live-dot + count badge on
   * each row. Stale by up to the server-component refresh interval; that's
   * fine for an "I have work" hint.
   */
  inFlightCounts?: Record<string, number>;
};

const TEMPLATE_ICONS: Record<AgentTemplateKey, LucideIcon> = {
  cmo: Briefcase,
  google_ads: Megaphone,
  seo: Search,
};

export function AgentNav({ projectSlug, agents, inFlightCounts = {} }: Props) {
  const pathname = usePathname();

  return (
    <SidebarMenu>
      {agents.map((a) => {
        // Every agent lands on Tasks now. The CMO's tasks are typically
        // its own first-turn work (onboarding audit, user-assigned planning
        // jobs); the work it delegates to specialists shows up in those
        // specialists' tabs. Chat tab is still one click away for free-form.
        const href = projectHref(projectSlug, `/agents/${a.slug}/tasks`);
        const agentBase = `/${projectSlug}/agents/${a.slug}`;
        const isActive =
          pathname === agentBase || pathname?.startsWith(`${agentBase}/`);
        const Icon = a.template_key ? TEMPLATE_ICONS[a.template_key] ?? Bot : Bot;
        const liveCount = inFlightCounts[a.key] ?? 0;
        const rolePalette = a.template_key ? colorForRole(a.template_key) : null;
        return (
          <SidebarMenuItem key={a.key}>
            <SidebarMenuButton asChild isActive={isActive}>
              <Link href={href}>
                <Icon />
                <span className="truncate">{a.name}</span>
                {a.role_label && rolePalette && (
                  <span
                    className={cn(
                      "ml-1 rounded-sm border px-1 py-px text-[9px] font-medium uppercase tracking-wider leading-none",
                      rolePalette.chip,
                    )}
                  >
                    {a.role_label}
                  </span>
                )}
                {liveCount > 0 && (
                  <span className="ml-auto inline-flex items-center gap-1.5">
                    <RunningDot size="sm" aria-label={`${liveCount} running`} />
                    <span className="text-[10px] font-medium tabular-nums text-sky-600 dark:text-sky-400">
                      {liveCount}
                    </span>
                  </span>
                )}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
