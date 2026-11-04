import type { JsonSchema } from "./types.js";

export const CREATE_CKD_SOP_GRAPH_NODE_IDS = [
  "prepare-catalog",
  "resolve-project",
  "select-sop-source",
  "resolve-processes",
  "generate-sop"
] as const;

export type CreateCkdSopGraphNodeId = typeof CREATE_CKD_SOP_GRAPH_NODE_IDS[number];
export type ProcessResolutionRoute = "same-project-reference" | "cross-project-reference" | "semantic-agent";

export interface CreateCkdSopGraphInput {
  sopType?: "assemble" | "assembly_test" | "pcba_test" | "aging_test" | "factory_test";
  templateLanguage?: "English" | "中文";
  projectName: string;
  documentNumber: string;
  sopName: string;
  /** Optional only so an already-started pre-Author Run can still resume. New Runs require it. */
  author?: string;
  factoryTestProcesses?: string[];
}

export const CREATE_CKD_SOP_SCRIPT_NAMES = [
  "build-ckd-catalog-v3",
  "normalize-ckd-inputs-v3",
  "resolve-ckd-reference-processes-v3",
  "resolve-ckd-transplant-reference-processes-v3",
  "create-ckd-sop-v3"
] as const;

const stringArray = { type: "array", items: { type: "string" } } as const;

export const PROJECT_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    requestedProjectName: { type: "string" },
    matchedProjectId: { type: "string" },
    matchedProjectName: { type: "string" },
    status: { type: "string", enum: ["semantic_match", "user_selected"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    comment: { type: "string" }
  },
  required: ["requestedProjectName", "matchedProjectId", "matchedProjectName", "status", "confidence", "comment"],
  additionalProperties: false
};

export const SOP_SELECTION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["custom", "reference"] },
    requestedSopName: { type: "string" },
    referenceSopId: { type: "string" },
    referenceSopName: { type: "string" },
    referenceProjectId: { type: "string" },
    referenceProjectName: { type: "string" },
    processList: { ...stringArray, minItems: 1, maxItems: 30 },
    referenceProcessIds: { ...stringArray, minItems: 1, maxItems: 30 },
    comment: { type: "string" }
  },
  required: ["mode", "requestedSopName", "processList", "comment"],
  additionalProperties: false
};

const processResultSchema: JsonSchema = {
  type: "object",
  properties: {
    requestedProcess: { type: "string" },
    resolvedProcessId: { type: "string" },
    resolvedProcessName: { type: "string" },
    overview: { type: "string", maxLength: 200 },
    status: { type: "string", enum: ["direct", "transplanted"] },
    sourceProjectId: { type: "string" },
    sourceProjectName: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    comment: { type: "string" },
    semanticMatch: {
      type: "string",
      enum: ["equivalent", "close", "partial", "different", "not_applicable"]
    },
    semanticReason: { type: "string", maxLength: 300 },
    warnings: { type: "array", maxItems: 2, items: { type: "string", maxLength: 200 } }
  },
  required: [
    "requestedProcess", "resolvedProcessId", "resolvedProcessName", "overview", "status",
    "sourceProjectId", "sourceProjectName", "confidence", "comment", "semanticMatch",
    "semanticReason", "warnings"
  ],
  additionalProperties: false
};

export const PROCESS_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    processes: { type: "array", minItems: 1, maxItems: 30, items: processResultSchema }
  },
  required: ["processes"],
  additionalProperties: false
};

export const SCRIPT_OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  "build-ckd-catalog-v3": requiredObject([
    "sopType", "templateLanguage", "catalogPath", "catalogHash", "projectCount", "processCount", "catalogProjects",
    "catalogSummary", "catalogDetails", "warnings", "sopCount", "sopCatalogSummary"
  ]),
  "normalize-ckd-inputs-v3": requiredObject([
    "sopType", "templateLanguage", "projectName", "documentNumber", "safeDocumentNumber", "sopName", "author", "processList",
    "referenceFastPathEligible", "referenceTransplantEligible", "semanticProcessResolutionRequired", "warnings"
  ]),
  "resolve-ckd-reference-processes-v3": PROCESS_RESULT_SCHEMA,
  "resolve-ckd-transplant-reference-processes-v3": PROCESS_RESULT_SCHEMA,
  "create-ckd-sop-v3": requiredObject([
    "sopType", "templateLanguage", "documentPath", "sheetCount", "processCount", "catalogHash", "warnings",
    "processReviews", "reviewSummary", "resultSummary"
  ])
};

export function processResolutionRoute(normalized: Record<string, unknown>): ProcessResolutionRoute {
  if (normalized.referenceFastPathEligible === true) return "same-project-reference";
  if (normalized.referenceTransplantEligible === true) return "cross-project-reference";
  if (normalized.semanticProcessResolutionRequired === true) return "semantic-agent";
  throw new Error("CKD process resolution did not select exactly one supported route.");
}

function requiredObject(required: string[]): JsonSchema {
  return {
    type: "object",
    required,
    additionalProperties: true
  };
}
