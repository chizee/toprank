"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { projectHref } from "@/lib/project-href";

type Props = {
  projectSlug: string;
  agentSlug: string;
};

/**
 * Discoverable "new chat" affordance next to the thread dropdown. Mints a
 * fresh UUID + routes to its chat URL — the dropdown's own "New thread"
 * item does the same, but having it as a top-level button surfaces the
 * action without an extra click into the menu.
 */
export function NewChatButton({ projectSlug, agentSlug }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function newThread() {
    const id = crypto.randomUUID();
    start(() =>
      router.push(projectHref(projectSlug, `/agents/${agentSlug}/chat/${id}`)),
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={newThread}
      disabled={pending}
      aria-label="New chat"
      title="New chat"
    >
      <Plus className="size-3.5" />
      <span className="ml-1">New chat</span>
    </Button>
  );
}
