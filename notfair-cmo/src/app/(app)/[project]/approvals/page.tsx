import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getProject } from "@/server/db/projects";
import {
  listActionableApprovals,
  listPolicies,
  listResolvedApprovals,
} from "@/server/db/approvals";
import { ApprovalCard } from "@/components/approval-card";
import { PolicyList } from "@/components/policy-list";
import { projectHref } from "@/lib/project-href";

type TabKey = "pending" | "resolved" | "policies";

function parseTab(raw: string | string[] | undefined): TabKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "resolved" || value === "policies") return value;
  return "pending";
}

export default async function ApprovalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { project: slug } = await params;
  const { tab } = await searchParams;
  const activeTab = parseTab(tab);

  const project = getProject(slug);
  if (!project || project.archived_at) notFound();

  // Bulk-fetch everything we render — better-sqlite3 is synchronous and the
  // page is small enough that one round-trip per panel keeps the code simple.
  const actionable = listActionableApprovals(project.slug);
  const resolved =
    activeTab === "resolved" ? listResolvedApprovals(project.slug, 50) : [];
  const policies = activeTab === "policies" ? listPolicies(project.slug) : [];

  const counts = {
    pending: actionable.length,
    resolved: resolved.length,
    policies: policies.length,
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Inbox for the project <span className="font-mono">{project.slug}</span>. Approvals
          surface here when an agent wants to make a write that the project's policies
          don't already cover.
        </p>
      </header>

      <nav className="flex gap-1 border-b border-border" role="tablist" aria-label="Approval tabs">
        <TabLink
          slug={slug}
          tab="pending"
          active={activeTab}
          label="Inbox"
          count={counts.pending}
          highlightCount
        />
        <TabLink slug={slug} tab="resolved" active={activeTab} label="Resolved" />
        <TabLink
          slug={slug}
          tab="policies"
          active={activeTab}
          label="Auto-approve rules"
        />
      </nav>

      {activeTab === "pending" && (
        actionable.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center">
              <h2 className="text-lg font-medium">All caught up.</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Agents will surface decisions here. Manage auto-approve rules in the
                <span className="px-1">
                  <Link
                    href={`${projectHref(slug, "/approvals")}?tab=policies`}
                    className="underline"
                  >
                    Auto-approve rules
                  </Link>
                </span>
                tab.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {actionable.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        )
      )}

      {activeTab === "resolved" && (
        resolved.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center">
              <h2 className="text-lg font-medium">No resolved approvals yet.</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Decisions show up here after they're approved, rejected, or auto-handled.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {resolved.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        )
      )}

      {activeTab === "policies" && (
        <PolicyList projectSlug={project.slug} policies={policies} />
      )}
    </div>
  );
}

function TabLink({
  slug,
  tab,
  active,
  label,
  count,
  highlightCount = false,
}: {
  slug: string;
  tab: TabKey;
  active: TabKey;
  label: string;
  count?: number;
  highlightCount?: boolean;
}) {
  const isActive = active === tab;
  const href = tab === "pending"
    ? projectHref(slug, "/approvals")
    : `${projectHref(slug, "/approvals")}?tab=${tab}`;
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={isActive}
      className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
        isActive
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <Badge
          variant={highlightCount ? "default" : "secondary"}
          className="h-5 px-1.5 text-[10px]"
        >
          {count}
        </Badge>
      )}
    </Link>
  );
}
