"use client";

import { useTransition } from "react";
import { useRouter, usePathname } from "next/navigation";
import { ChevronsUpDown, Plus, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import type { Project } from "@/types";
import { switchProjectAction } from "@/server/actions/projects";
import { projectHref, subPathFromPathname } from "@/lib/project-href";
import { toast } from "sonner";

type Props = {
  projects: Project[];
  activeSlug: string | null;
};

export function ProjectSwitcher({ projects, activeSlug }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const active = projects.find((p) => p.slug === activeSlug) ?? null;

  function pick(slug: string) {
    if (slug === activeSlug) return;
    const subPath = subPathFromPathname(pathname, activeSlug);
    start(async () => {
      const result = await switchProjectAction(slug);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.push(projectHref(slug, subPath));
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
          <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground text-xs font-semibold">
            {(active?.display_name ?? "—").slice(0, 2).toUpperCase()}
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">
              {active?.display_name ?? "No project"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {active ? active.slug : "Create one to get started"}
            </span>
          </div>
          <ChevronsUpDown className="ml-auto size-4" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Projects
        </DropdownMenuLabel>
        {projects.length === 0 && (
          <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
        )}
        {projects.map((p) => (
          <DropdownMenuItem
            key={p.slug}
            onSelect={() => pick(p.slug)}
            disabled={pending}
            className="gap-2"
          >
            <div className="flex aspect-square size-6 items-center justify-center rounded bg-muted text-[10px] font-semibold">
              {p.display_name.slice(0, 2).toUpperCase()}
            </div>
            <span className="flex-1 truncate">{p.display_name}</span>
            {p.slug === activeSlug && <Check className="size-4 text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/onboarding" className="gap-2">
            <Plus className="size-4" />
            <span>New project</span>
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
