"use client";

import { useTransition } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type ReprovisionResult =
  | { ok: true; created: string[]; existed: string[] }
  | { ok: false; error: string };

type Props = {
  action: () => Promise<ReprovisionResult>;
};

export function ReprovisionButton({ action }: Props) {
  const [pending, start] = useTransition();

  function go() {
    start(async () => {
      const r = await action();
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const created = r.created.length;
      const existed = r.existed.length;
      toast.success(
        created > 0
          ? `Provisioned ${created} new agent${created === 1 ? "" : "s"}.`
          : `All ${existed} agents already exist.`,
      );
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={go} disabled={pending}>
      <RotateCw className={`mr-1.5 size-4 ${pending ? "animate-spin" : ""}`} />
      {pending ? "Provisioning..." : "Reprovision agents"}
    </Button>
  );
}
