import type { Clarification, GraphWorkflowNodeRun, GraphWorkflowRun, JsonSchema, JsonValue, WorkflowStepSubmission } from "./types.js";

export type GraphNodeType = "agent" | "script" | "hybrid" | "custom";
export interface GraphScriptExecutionRequest {
  id: string; script: string; values: Record<string, JsonValue>; outputSchema: JsonSchema; timeoutSeconds?: number; final?: boolean;
}
export interface GraphScriptNodeRequest extends Omit<GraphScriptExecutionRequest, "id"> { nodeType?: GraphNodeType }
export interface GraphClarificationRequest extends Partial<Omit<Clarification, "question">> { question: string }
export interface GraphClarificationResolution { result: WorkflowStepSubmission; repeatNode?: boolean }
export interface GraphStructuredRunRequest {
  task: string; outputSchema: JsonSchema; outputDescription?: string; approvalMode?: string; allowedToolNames?: readonly string[];
}
export interface GraphNodeExecutionContext {
  readonly run: GraphWorkflowRun;
  createNodeRun(values: Record<string, JsonValue>, nodeType?: GraphNodeType): GraphWorkflowNodeRun;
  executeScript(request: GraphScriptExecutionRequest): Promise<WorkflowStepSubmission>;
  executeScriptNode(request: GraphScriptNodeRequest): Promise<boolean>;
  runStructured(nodeRunId: string, request: GraphStructuredRunRequest): Promise<boolean>;
  requestClarification(nodeRunId: string, request: GraphClarificationRequest): boolean;
  completeNode(nodeRunId: string, result: WorkflowStepSubmission, final?: boolean): GraphWorkflowRun;
  patchSharedState(patch: Record<string, JsonValue>): GraphWorkflowRun;
  failNode(nodeRunId: string, error: unknown): GraphWorkflowRun;
}
export interface GraphStructuredResultContext { run: GraphWorkflowRun; nodeRun: GraphWorkflowNodeRun }
export interface GraphWorkflowNodeDefinition {
  id: string; title: string; type: GraphNodeType;
  execute(context: GraphNodeExecutionContext): Promise<boolean>;
  structuredResult?(output: JsonValue, context: GraphStructuredResultContext): WorkflowStepSubmission;
  resolveClarification?(answer: string, context: GraphStructuredResultContext & { toolCallId: string }): GraphClarificationResolution;
}
export interface GraphWorkflowDefinition<T> {
  name: string; title: string; description: string; inputSchema: JsonSchema;
  nodes: readonly GraphWorkflowNodeDefinition[]; scriptNames: readonly string[];
  validateInputs(input: T): Record<string, JsonValue>;
  nextNode(run: GraphWorkflowRun, completedNodeId: string): string | undefined;
}
