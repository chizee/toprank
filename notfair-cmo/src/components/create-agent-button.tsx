"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { CreateAgentDialog } from "./create-agent-dialog";

type Props = {
  /** Active project slug — used as the agent_id prefix in the name input. */
  projectSlug: string;
};

export function CreateAgentButton({ projectSlug }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Create or clone agent"
        aria-label="Create or clone agent"
      >
        <Plus className="size-3.5" />
      </button>
      <CreateAgentDialog
        open={open}
        onOpenChange={setOpen}
        projectSlug={projectSlug}
      />
    </>
  );
}
