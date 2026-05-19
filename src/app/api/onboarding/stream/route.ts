import { NextRequest } from "next/server";
import { STEP_ORDER, STEP_RUNNERS, type StepId } from "@/lib/onboarding/steps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Event =
  | { type: "step:start"; id: StepId }
  | { type: "step:done"; id: StepId; preview: unknown }
  | { type: "step:error"; id: StepId; message: string }
  | { type: "complete" };

function sse(event: Event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url")?.trim() || "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (e: Event) => controller.enqueue(encoder.encode(sse(e)));

      for (const step of STEP_ORDER) {
        send({ type: "step:start", id: step.id });
        try {
          const preview = await STEP_RUNNERS[step.id](url, step.sleepMs);
          send({ type: "step:done", id: step.id, preview });
        } catch (err) {
          send({
            type: "step:error",
            id: step.id,
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }

      send({ type: "complete" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
