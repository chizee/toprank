import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { getProject } from "@/server/db/projects";
import { resolveAgentBySlug } from "@/server/agent-meta";
import { listCronsForProject } from "@/server/openclaw/crons";
import {
  annotateOccurrencesWithRunStatus,
  expandSchedule,
} from "@/server/openclaw/cron-schedule";
import {
  CronCalendar,
  type CalendarCron,
  type CalendarOccurrence,
} from "@/components/cron-calendar";
import { ScheduleCronDialog } from "@/components/schedule-cron-dialog";
import type { ScheduleInput } from "@/server/actions/cron-runs";

const NUM_DAYS = 14;

/**
 * Narrow the loose `CronSchedule` shape from OpenClaw to the discriminated
 * union our run-matching server action accepts. Drops schedules whose `kind`
 * we don't recognise so the action can fall back to time-window matching.
 */
function scheduleForCalendar(s: unknown): ScheduleInput | null {
  if (!s || typeof s !== "object") return null;
  const obj = s as { kind?: string; expr?: unknown; tz?: unknown; everyMs?: unknown; anchorMs?: unknown };
  if (obj.kind === "cron" && typeof obj.expr === "string") {
    return { kind: "cron", expr: obj.expr, ...(typeof obj.tz === "string" ? { tz: obj.tz } : {}) };
  }
  if (obj.kind === "every" && typeof obj.everyMs === "number") {
    return {
      kind: "every",
      everyMs: obj.everyMs,
      ...(typeof obj.anchorMs === "number" ? { anchorMs: obj.anchorMs } : {}),
    };
  }
  return null;
}

type Params = { agent: string; project: string };

export default async function AgentCronPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { agent: agentSlug, project: projectSlug } = await params;
  const project = getProject(projectSlug);
  if (!project || project.archived_at) notFound();
  const resolved = await resolveAgentBySlug(project.slug, agentSlug);
  if (!resolved) notFound();

  const templateSlug = resolved.slug;

  let error: string | null = null;
  let view: Awaited<ReturnType<typeof listCronsForProject>>;
  try {
    view = await listCronsForProject(project.slug);
  } catch (err) {
    view = { project_slug: project.slug, groups: [] };
    error = err instanceof Error ? err.message : String(err);
  }

  // Scope to this agent only.
  const myGroup = view.groups.find((g) => g.agent === templateSlug);
  const allCrons = myGroup?.crons ?? [];

  // Expand to occurrences over the window.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startOfFirstDay = today.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const until = startOfFirstDay + NUM_DAYS * dayMs;

  const occurrences: CalendarOccurrence[] = [];
  const schedulesByCronId = new Map<string, ReturnType<typeof scheduleForCalendar>>();
  for (const cron of allCrons) {
    const occs = expandSchedule(
      cron.id,
      cron.schedule_raw,
      { from: startOfFirstDay, until },
      {
        name: cron.name,
        short_name: cron.short_name,
        agent_id: cron.agent_id,
        agent_slug: cron.agent_slug,
        schedule_text: cron.schedule_text,
      },
    );
    for (const o of occs) occurrences.push({ ...o, cron_disabled: cron.disabled });
    schedulesByCronId.set(cron.id, scheduleForCalendar(cron.schedule_raw));
  }
  // Stamp each past occurrence with its run's status so the calendar chip
  // can render the green-check / red-X indicator without a per-chip fetch.
  annotateOccurrencesWithRunStatus(
    occurrences,
    new Map(
      [...schedulesByCronId.entries()].map(([k, v]) => [k, v ?? undefined]),
    ),
  );

  const cronsById: Record<string, CalendarCron> = {};
  for (const cron of allCrons) {
    cronsById[cron.id] = {
      id: cron.id,
      short_name: cron.short_name,
      full_name: cron.name,
      agent_id: cron.agent_id,
      agent_slug: cron.agent_slug,
      schedule_text: cron.schedule_text,
      disabled: cron.disabled,
      status_text: cron.status_text,
      message: cron.message,
      description: cron.description,
      last_run_at_ms: cron.last_run_at_ms,
      last_status: cron.last_status,
      last_error: cron.last_error,
      schedule_raw: scheduleForCalendar(cron.schedule_raw),
    };
  }

  const totalActive = allCrons.filter((c) => !c.disabled).length;
  const totalDisabled = allCrons.length - totalActive;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex flex-row items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {resolved.name}&rsquo;s scheduled work
            </h2>
            <p className="text-sm text-muted-foreground">
              {totalActive} active
              {totalDisabled > 0 ? ` · ${totalDisabled} disabled` : ""}
              {" · backed by OpenClaw"}
            </p>
          </div>
          <ScheduleCronDialog projectSlug={project.slug} />
        </header>

        {error && (
          <Card>
            <CardContent className="py-6 text-sm">
              <p className="font-medium text-destructive">Could not reach OpenClaw.</p>
              <p className="mt-1 text-xs text-muted-foreground">{error}</p>
            </CardContent>
          </Card>
        )}

        {!error && allCrons.length === 0 && (
          <Card>
            <CardContent className="space-y-2 py-10 text-center">
              <p className="text-sm font-medium">
                No scheduled work for {resolved.name} yet.
              </p>
              <p className="text-xs text-muted-foreground">
                Ask the agent in chat (&ldquo;run a daily bid review at 9am&rdquo;) or
                schedule one directly.
              </p>
              <div className="flex justify-center pt-2">
                <ScheduleCronDialog projectSlug={project.slug} />
              </div>
            </CardContent>
          </Card>
        )}

        {!error && allCrons.length > 0 && (
          <CronCalendar
            startOfFirstDay={startOfFirstDay}
            numDays={NUM_DAYS}
            occurrences={occurrences}
            cronsById={cronsById}
            agentSlugs={[templateSlug]}
          />
        )}
      </div>
    </div>
  );
}
