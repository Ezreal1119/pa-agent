import type { ModelConfig } from "../config.js";
import { onesProfile, validateOnesActivation, type onesConnection, type OnesOptions } from "../ones-agent/config.js";
import { ONES_DELEGATION_TOOL, ONES_FINISH_TOOL, ONES_GUIDANCE } from "../ones-agent/tool.js";

export const SUB_AGENT_IDS = ["ones"] as const;
export type SubAgentId = typeof SUB_AGENT_IDS[number];
export type SubAgentSwitches = Partial<Record<SubAgentId, boolean>>;

interface ToolSummary { name: string; label: string; description: string; }
interface SubAgentCatalogEntry {
  id: SubAgentId;
  name: string;
  description: string;
  supervisorTool: ToolSummary & { guidance: string };
  internalTools: ToolSummary[];
  mcpTools: string[];
  prompt: string;
  unavailable?: string;
}

export function subAgentId(value: string): value is SubAgentId {
  return (SUB_AGENT_IDS as readonly string[]).includes(value);
}

export function validateSubAgentSwitches(input: unknown): SubAgentSwitches {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.entries(input).some(([id, enabled]) => !subAgentId(id) || typeof enabled !== "boolean")) {
    throw new Error("Provide a boolean switch for each named sub-agent.");
  }
  return { ...input };
}

export function onesCatalogEntry(resourcesDir: string, model: ModelConfig, options: OnesOptions | undefined, connection: ReturnType<typeof onesConnection>): SubAgentCatalogEntry {
  let profile: ReturnType<typeof onesProfile>;
  const entry = {
    id: "ones" as const,
    name: "ONES Agent",
    description: "Queries software test submissions, releases, after-sales work items, and the ONES Wiki.",
    supervisorTool: { ...ONES_DELEGATION_TOOL, guidance: ONES_GUIDANCE },
    internalTools: [ONES_FINISH_TOOL],
  };
  try {
    profile = onesProfile(resourcesDir, options);
  } catch {
    return { ...entry, prompt: "", mcpTools: [], unavailable: "The ONES prompt or tool configuration could not be loaded. Check the deployed resources and restart the service." };
  }
  try {
    validateOnesActivation(profile, model, connection);
    return { ...entry, prompt: profile.prompt, mcpTools: profile.tools };
  } catch (error) {
    return { ...entry, prompt: profile.prompt, mcpTools: profile.tools, unavailable: (error as Error).message };
  }
}
