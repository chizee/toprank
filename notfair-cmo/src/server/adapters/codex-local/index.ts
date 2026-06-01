import type {
  HarnessAdapter,
  HarnessExecuteContext,
  HarnessEvent,
  AgentProvisionSpec,
  McpRegistrationSpec,
} from "../types";
import { executeCodexLocal } from "./execute";
import { provisionCodexAgent } from "./provision";
import { testCodexLocalEnvironment } from "./test";
import { registerCodexMcp, unregisterCodexMcp } from "./mcp";

export const codexLocalAdapter: HarnessAdapter = {
  id: "codex-local",
  testEnvironment: testCodexLocalEnvironment,
  execute(ctx: HarnessExecuteContext): AsyncGenerator<HarnessEvent, void, void> {
    return executeCodexLocal(ctx);
  },
  async provisionAgent(spec: AgentProvisionSpec): Promise<void> {
    await provisionCodexAgent(spec);
  },
  async registerMcp(spec: McpRegistrationSpec): Promise<void> {
    await registerCodexMcp(spec);
  },
  async unregisterMcp(serverName: string, agentId: string): Promise<void> {
    await unregisterCodexMcp(serverName, agentId);
  },
};
