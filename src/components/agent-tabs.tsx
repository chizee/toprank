"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, FileText, Sparkles, Clock, Settings, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

type Tab = {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const TABS: Tab[] = [
  { key: "chat", label: "Chat", icon: MessageSquare },
  { key: "tasks", label: "Tasks", icon: ListChecks },
  { key: "files", label: "Files", icon: FileText },
  { key: "skills", label: "Skills", icon: Sparkles },
  { key: "cron", label: "Cron", icon: Clock },
  { key: "settings", label: "Settings", icon: Settings },
];

export function AgentTabs({ agentSlug }: { agentSlug: string }) {
  const pathname = usePathname();
  const base = `/agents/${agentSlug}`;

  return (
    <nav
      className="flex items-center gap-1 border-b bg-background/60 px-4 backdrop-blur"
      aria-label="Agent sections"
    >
      {TABS.map(({ key, label, icon: Icon }) => {
        const href = `${base}/${key}`;
        const isActive =
          pathname === href || pathname?.startsWith(`${href}/`);
        return (
          <Link
            key={key}
            href={href}
            className={cn(
              "relative flex items-center gap-1.5 px-3 py-2 text-sm transition-colors",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
            {isActive && (
              <span
                aria-hidden
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
