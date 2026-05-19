import Link from "next/link";
import { MessageSquare, Clock, Bot, ListChecks, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getActiveProject } from "@/server/active-project";
import { costToday } from "@/server/db/cost";
import { listPendingApprovals } from "@/server/db/approvals";
import { listTasks } from "@/server/db/tasks";
import { listAgentActions } from "@/server/db/agent-actions";
import { TEMPLATES, urlSlugForTemplate, type AgentTemplateKey } from "@/server/agent-templates";

function formatUsd(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function timeAgo(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default async function ProjectHomePage() {
  const project = await getActiveProject();

  if (!project) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-start gap-4 pt-16">
        <h1 className="text-2xl font-semibold tracking-tight">
          Hire a CMO.
        </h1>
        <p className="text-sm text-muted-foreground">
          Connect your Google Ads account and watch a real audit in under 60
          seconds. Skip the connect if you just want to chat.
        </p>
        <Button asChild size="lg">
          <Link href="/onboarding">Set up your CMO</Link>
        </Button>
      </div>
    );
  }

  const cost = costToday(project.slug);
  const pending = listPendingApprovals(project.slug);
  const tasks = listTasks(project.slug);
  const recent = listAgentActions(project.slug, 8);

  // Intentionally NOT calling openclaw here. The cron tab is the source of
  // truth for scheduled jobs; calling `openclaw cron list` from the home page
  // would block render for 5-15s on some machines. Show a link instead.
  const running = tasks.filter((t) => t.status === "running").length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{project.display_name}</h1>
          <p className="text-sm text-muted-foreground">
            Project home · slug <span className="font-mono">{project.slug}</span>
          </p>
        </div>
        <Button asChild>
          <Link href="/agents/cmo/chat">
            <MessageSquare className="mr-1.5 size-4" />
            Chat with CMO
          </Link>
        </Button>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 md:grid-cols-4">
        <KpiCard
          label="Spend today"
          value={formatUsd(cost.total_usd)}
          hint={`LLM ${formatUsd(cost.by_source.llm)} · Ads ${formatUsd(
            cost.by_source.google_ads + cost.by_source.gsc,
          )}`}
        />
        <KpiCard
          label="Scheduled crons"
          value="→"
          hint="open cron tab"
          href="/crons"
        />
        <KpiCard
          label="Active tasks"
          value={String(running)}
          hint={`${tasks.length} total`}
          href="/tasks"
        />
        <KpiCard
          label="Pending approvals"
          value={String(pending.length)}
          hint={pending.length === 0 ? "all caught up" : "review →"}
          href="/approvals"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Agents column */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Your agents</CardTitle>
                <CardDescription>
                  Each agent runs in its own OpenClaw workspace. Click to chat.
                </CardDescription>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href="/agents">View all</Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {TEMPLATES.map((t) => {
              const slug = urlSlugForTemplate(t.key as AgentTemplateKey);
              return (
                <Link
                  key={t.key}
                  href={`/chat/${slug}`}
                  className="flex items-center gap-3 rounded-md border bg-card p-3 transition-colors hover:bg-accent/50"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Bot className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{t.display_name}</div>
                    <p className="line-clamp-1 text-xs text-muted-foreground">{t.description}</p>
                  </div>
                  <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              );
            })}
          </CardContent>
        </Card>

        {/* Activity column */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Recent activity</CardTitle>
                <CardDescription>Last 8 agent actions</CardDescription>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href="/activity">All</Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <div className="space-y-2 text-sm">
                <p className="text-muted-foreground">No activity yet.</p>
                <p className="text-xs text-muted-foreground">
                  Activity logs autonomous decisions, scheduled work, and tool calls.
                </p>
              </div>
            ) : (
              <ul className="space-y-2.5 text-xs">
                {recent.map((a) => (
                  <li key={a.id} className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-[9px]">
                        {a.action_type}
                      </Badge>
                      <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                        {timeAgo(a.occurred_at)}
                      </span>
                    </div>
                    <p className="line-clamp-2 leading-snug">{a.summary}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Onboarding nudge if nothing has happened yet */}
      {tasks.length === 0 && recent.length === 0 && (
        <Card>
          <CardContent className="space-y-3 py-6 text-sm">
            <h3 className="font-medium">Getting started</h3>
            <ol className="space-y-1.5 text-muted-foreground">
              <li>
                1. <Link href="/connections" className="underline">Connect Google Ads or GSC</Link>{" "}
                if you want agents to do real work (optional, chat works without it)
              </li>
              <li>
                2. <Link href="/agents/cmo/chat" className="underline">Chat with the CMO</Link> to plan
                what to do
              </li>
              <li>
                3. <Link href="/crons" className="underline">Schedule recurring jobs</Link> for
                specialist agents
              </li>
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: string;
  hint: string;
  href?: string;
}) {
  const content = (
    <Card className={href ? "transition-colors hover:bg-accent/30" : undefined}>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 text-xs text-muted-foreground">{hint}</CardContent>
    </Card>
  );
  if (href)
    return (
      <Link href={href} className="block">
        {content}
      </Link>
    );
  return content;
}

// Silence unused lint for icons reserved for future activity-feed expansion.
void ListChecks;
void CheckCircle2;
