import { spawn } from "node:child_process";

export type AgentTurnInput = {
  agent: string;
  message: string;
  sessionId?: string;
  timeoutMs?: number;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
};

/**
 * Stream the output of `openclaw agent --agent <name> --message <text>`.
 * We yield text chunks as they arrive on stdout. The OpenClaw CLI emits
 * a mix of progress and final-answer text; consumers can filter.
 */
export async function* streamAgentTurn(input: AgentTurnInput): AsyncGenerator<string, void, void> {
  const args = [
    "agent",
    "--agent",
    input.agent,
    "--message",
    input.message,
  ];
  if (input.sessionId) {
    args.push("--session-id", input.sessionId);
  }
  if (input.thinking) {
    args.push("--thinking", input.thinking);
  }

  const proc = spawn("openclaw", args, { stdio: ["ignore", "pipe", "pipe"] });
  const timeout = setTimeout(() => proc.kill("SIGTERM"), input.timeoutMs ?? 300_000);

  try {
    const stdoutQueue: string[] = [];
    let stdoutEnded = false;
    let rejectErr: Error | null = null;

    const onChunk = (chunk: Buffer) => {
      stdoutQueue.push(chunk.toString("utf8"));
    };

    const stdoutEnd = new Promise<void>((resolve, reject) => {
      proc.stdout.on("data", onChunk);
      proc.stdout.on("end", () => {
        stdoutEnded = true;
        resolve();
      });
      proc.on("error", (err) => {
        rejectErr = err;
        reject(err);
      });
    });

    // Drain stderr to avoid backpressure; surface on close if exit was nonzero.
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("close", (code) => resolve(code));
    });

    while (!stdoutEnded || stdoutQueue.length > 0) {
      if (stdoutQueue.length > 0) {
        yield stdoutQueue.shift()!;
      } else {
        await Promise.race([
          new Promise<void>((res) => proc.stdout.once("data", () => res())),
          stdoutEnd,
        ]);
      }
      if (rejectErr) throw rejectErr;
    }

    const code = await exitPromise;
    if (code !== 0) {
      throw new Error(
        `openclaw agent exited with code ${code}. stderr: ${stderr.trim().slice(0, 500)}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
