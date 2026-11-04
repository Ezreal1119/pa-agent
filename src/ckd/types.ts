export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export interface WorkflowStepSubmission {
  summary: string;
  output: JsonValue;
  artifacts: string[];
  statePatch?: Record<string, JsonValue>;
}
export type RunStatus = "running" | "awaiting_clarification" | "awaiting_image_review" | "completed" | "failed" | "terminated" | "cancelled";
export interface ImageCheckProgress {
  status: "running" | "completed" | "failed" | "cancelled";
  completed: number;
  total: number;
  phase: "pixel" | "focus";
  processName?: string;
  imageName?: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
}
export interface GraphWorkflowNodeRun {
  id: string;
  nodeId: string;
  input: Record<string, JsonValue>;
  status: RunStatus;
  result?: WorkflowStepSubmission;
  error?: string;
  sessionFile?: string;
  questions?: (PendingQuestion & { answer?: string })[];
}
export interface Clarification {
  question: string;
  options: readonly string[];
  allowFreeText: boolean;
  answerRequired: boolean;
  inputUi?: Record<string, unknown>;
}
export interface PendingQuestion extends Clarification {
  id: string;
  nodeRunId: string;
  kind: "deterministic" | "agent";
}
export interface AgentCheckpoint {
  nodeRunId: string;
  sessionFile?: string;
  request: { task: string; outputSchema: JsonSchema; outputDescription?: string };
  action?: { kind: "submit"; output: JsonValue } | { kind: "terminate"; reason: string } | { kind: "clarify"; question: Clarification };
  answer?: { questionId: string; question: string; text: string };
  /** Last durable Pi transcript leaf before an invocation; used to replay interrupted calls. */
  leafId?: string | null;
}
export interface GraphWorkflowRun {
  schemaVersion: 1;
  id: string;
  workflowName: string;
  status: RunStatus;
  currentNodeId?: string;
  inputs: Record<string, JsonValue>;
  sharedState: Record<string, JsonValue>;
  nodeOutputs: Record<string, WorkflowStepSubmission>;
  nodes: GraphWorkflowNodeRun[];
  workspaceRoot: string;
  workspaceRelative: string;
  libraryPath: string;
  scriptHashes: Record<string, string>;
  stageCommitted?: boolean;
  pendingQuestion?: PendingQuestion;
  agentCheckpoint?: AgentCheckpoint;
  imageReviewMode?: 1;
  imageReview?: import("./image-review-stage.js").ImageReviewStage;
  finalResult?: WorkflowStepSubmission;
  /** Workbook committed by the generator; the image report may still be pending. */
  generatedResult?: WorkflowStepSubmission;
  imageCheck?: ImageCheckProgress;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export type CkdRun = GraphWorkflowRun;
export interface CkdEvent { runId: string; type: "stage" | "question" | "agent" | "status"; message: string }
export interface AgentExecution {
  run: CkdRun;
  checkpoint: AgentCheckpoint;
  persist(): void;
  signal: AbortSignal;
  onEvent?: (event: CkdEvent) => void;
}
export interface CkdAgent { execute(input: AgentExecution): Promise<void> }
