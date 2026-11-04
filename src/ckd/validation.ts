import { Ajv } from "ajv";
import type { CkdRun, Clarification, JsonSchema, JsonValue } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false });
export function validate(schema: JsonSchema, value: unknown): asserts value is JsonValue {
  const checker = ajv.compile(schema);
  if (!checker(value)) throw new Error(`Invalid structured value: ${ajv.errorsText(checker.errors)}`);
}
export function clarification(value: unknown): Clarification {
  validate({ type: "object", properties: { question: { type: "string", minLength: 1, maxLength: 12000 }, options: { type: "array", maxItems: 12, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4000 } }, allowFreeText: { type: "boolean" }, answerRequired: { type: "boolean" }, inputUi: { type: "object" } }, required: ["question"], additionalProperties: false }, value);
  const request = value as unknown as Partial<Clarification>;
  const result = { ...request, question: request.question!.trim(), options: request.options ?? [], allowFreeText: request.allowFreeText ?? true, answerRequired: request.answerRequired ?? true };
  if (!result.question || (!result.allowFreeText && !result.options.length)) throw new Error("Clarification requires a question and usable answer options.");
  return result;
}
export function validateDecision(run: CkdRun, nodeId: string, output: JsonValue): void {
  const record = output as Record<string, any>;
  const catalog = run.nodeOutputs["prepare-catalog"]?.output as Record<string, any>;
  if (!catalog) throw new Error("Frozen CKD Catalog is required.");
  if (nodeId === "resolve-project") {
    const candidates = catalog.catalogProjects.projects as Record<string, any>[];
    const match = candidates.find(project => project.projectId === record.matchedProjectId);
    if (!match || match.displayName !== record.matchedProjectName) throw new Error("Project decision is outside the frozen Catalog.");
    if (record.requestedProjectName !== run.inputs.projectName) throw new Error("Project decision changed the original request.");
  } else if (nodeId === "select-sop-source") {
    if (record.mode !== "reference") throw new Error("The reference selection node must select a Library SOP.");
    if (!catalog.sopCatalogSummary.sops.some((sop: Record<string, any>) => sop.sopId === record.referenceSopId && sop.projectId === record.referenceProjectId)) throw new Error("SOP decision is outside the frozen Catalog.");
    if (record.requestedSopName !== run.inputs.sopName) throw new Error("SOP decision changed the original request.");
  } else if (nodeId === "resolve-processes") {
    const expected = (run.sharedState.normalizedInputs as Record<string, JsonValue>).processList as string[];
    const plans = record.processes as Record<string, any>[];
    if (plans.length !== expected.length) throw new Error("Process decision count differs from the confirmed sequence.");
    const seen = new Set<string>();
    const target = run.sharedState.projectMatchResult as Record<string, JsonValue>;
    plans.forEach((plan, index) => {
      const candidate = catalog.catalogSummary.processes.find((item: Record<string, any>) => item.processId === plan.resolvedProcessId);
      if (plan.requestedProcess !== expected[index] || !candidate || seen.has(plan.resolvedProcessId)) throw new Error("Process IDs/order differ from the frozen Catalog or confirmed sequence.");
      seen.add(plan.resolvedProcessId);
      if (plan.status !== "direct" || plan.sourceProjectId !== target.matchedProjectId || plan.sourceProjectName !== target.matchedProjectName || plan.semanticMatch === "not_applicable") throw new Error("Semantic decisions must retain target project content and a semantic assessment.");
    });
  }
}
