// CKD V3 business nodes migrated from patrick-agent; host contracts are local.
import type { JsonValue, WorkflowStepSubmission } from "./types.js";
import {
  CREATE_CKD_SOP_GRAPH_NODE_IDS,
  CREATE_CKD_SOP_SCRIPT_NAMES,
  PROCESS_RESULT_SCHEMA,
  PROJECT_RESULT_SCHEMA,
  SCRIPT_OUTPUT_SCHEMAS,
  SOP_SELECTION_SCHEMA,
  processResolutionRoute,
  type CreateCkdSopGraphInput,
  type CreateCkdSopGraphNodeId,
  type ProcessResolutionRoute
} from "./contract.js";
import {
  projectPrompt,
  semanticProcessesPrompt,
  sopSelectionPrompt
} from "./prompts.js";
import type {
  GraphClarificationRequest,
  GraphClarificationResolution,
  GraphNodeExecutionContext,
  GraphWorkflowDefinition,
  GraphWorkflowNodeDefinition
} from "./definition.js";
import type { GraphWorkflowRun } from "./types.js";

export const CREATE_CKD_SOP_GRAPH_TOPOLOGY = {
  nodes: [
    { id: "prepare-catalog", type: "script" },
    { id: "resolve-project", type: "agent" },
    { id: "select-sop-source", type: "agent" },
    { id: "resolve-processes", type: "hybrid" },
    { id: "generate-sop", type: "script" }
  ],
  decision: {
    id: "process-resolution-route",
    inside: "resolve-processes",
    branches: ["same-project-reference", "cross-project-reference", "semantic-agent"]
  }
} as const;

const CUSTOM_PROCESS_LIMIT = 30;
const CUSTOM_PROCESS_NAME_LIMIT = 120;
const CUSTOM_PROCESS_CONTINUE_OPTION = "继续输入，我将在自由文本中补充下一个 Process";
const CUSTOM_PROCESS_REMOVE_DUPLICATES_CONTINUE_OPTION = "移除重复项，并按首次出现的顺序继续";
const CUSTOM_PROCESS_REMOVE_DUPLICATES_COMPLETE_OPTION = "移除重复项，并按首次出现的顺序完成";
const CUSTOM_PROCESS_REENTER_OPTION = "返回重新输入本次内容";

type CustomProcessCollectionStage = "collect" | "confirm-single" | "confirm-duplicates";

interface CustomProcessCollectionState {
  stage: CustomProcessCollectionStage;
  processList: string[];
  pendingProcessList?: string[];
  afterDuplicateAction?: "confirm-single" | "complete";
  error?: string;
}

const nodes: readonly GraphWorkflowNodeDefinition[] = [
  {
    id: "prepare-catalog",
    title: "Prepare CKD Catalog",
    type: "script",
    execute: (context) => context.executeScriptNode({
      script: "build-ckd-catalog-v3",
      values: {
        sopType: context.run.inputs.sopType!,
        templateLanguage: context.run.inputs.templateLanguage ?? "English"
      },
      outputSchema: SCRIPT_OUTPUT_SCHEMAS["build-ckd-catalog-v3"]!,
      timeoutSeconds: 120
    })
  },
  {
    id: "resolve-project",
    title: "Resolve Project",
    type: "agent",
    async execute(context) {
      const catalog = outputRecord(context.run, "prepare-catalog");
      const values = {
        requestedProjectName: context.run.inputs.projectName!,
        catalogProjects: catalog.catalogProjects as JsonValue
      };
      const nodeRun = context.createNodeRun(values);
      const exactMatch = deterministicExactProjectMatchV3(
        context.run.inputs.projectName,
        catalog.catalogProjects
      );
      if (exactMatch) {
        context.completeNode(nodeRun.id, {
          summary: "已通过精确名称完成项目匹配。",
          output: exactMatch,
          artifacts: [],
          statePatch: { projectMatchResult: exactMatch }
        });
        return true;
      }
      return context.runStructured(nodeRun.id, {
        task: projectPrompt(context.run, catalog.catalogProjects),
        outputSchema: PROJECT_RESULT_SCHEMA,
        outputDescription: "Return the resolved CKD Project decision.",
        approvalMode: "full_access",
        allowedToolNames: []
      });
    },
    structuredResult(output) {
      return {
        summary: "已完成项目匹配。",
        output,
        artifacts: [],
        statePatch: { projectMatchResult: output }
      };
    }
  },
  {
    id: "select-sop-source",
    title: "Select SOP Source",
    type: "agent",
    async execute(context) {
      const catalog = outputRecord(context.run, "prepare-catalog");
      if (context.run.inputs.sopType === "factory_test") {
        const processList = readFactoryTestProcessList(context.run.inputs.factoryTestProcesses);
        const selection = {
          mode: "custom",
          requestedSopName: requiredText(context.run.inputs.sopName, "sopName"),
          processList,
          comment: `Factory Test Process Builder：用户确认了 ${processList.length} 个 Process，按拖拽顺序冻结。`
        } satisfies Record<string, JsonValue>;
        const nodeRun = context.createNodeRun({
          sopName: context.run.inputs.sopName!,
          projectMatchResult: context.run.sharedState.projectMatchResult!,
          sopCatalogSummary: catalog.sopCatalogSummary as JsonValue,
          sourceMode: "factory-test-builder",
          factoryTestProcesses: processList
        });
        context.completeNode(nodeRun.id, {
          summary: `已确认 Factory Test Process Builder 顺序：共 ${processList.length} 个 Process。`,
          output: selection,
          artifacts: [],
          statePatch: { sopProcessSelection: selection }
        });
        return true;
      }
      const sourceMode = context.run.sharedState.sopSourceMode;
      const baseValues = {
        sopName: context.run.inputs.sopName!,
        projectMatchResult: context.run.sharedState.projectMatchResult!,
        sopCatalogSummary: catalog.sopCatalogSummary as JsonValue
      };
      if (sourceMode !== "custom" && sourceMode !== "reference") {
        const nodeRun = context.createNodeRun({
          ...baseValues,
          graphClarificationKind: "sop-source-mode"
        });
        return context.requestClarification(nodeRun.id, {
          question: "请选择 SOP 流程的来源。",
          options: ["手动输入 SOP Processes", "参考 Library 中已有 SOP"],
          allowFreeText: false,
          answerRequired: true
        });
      }
      if (sourceMode === "custom") {
        const collection = readCustomProcessCollection(context.run.sharedState.customProcessCollection);
        const clarification = customProcessClarificationV3(context.run, collection);
        const nodeRun = context.createNodeRun({
          ...baseValues,
          sourceMode,
          graphClarificationKind: clarification.kind,
          customProcessCollection: collection as unknown as JsonValue
        });
        return context.requestClarification(nodeRun.id, clarification.request);
      }
      const nodeRun = context.createNodeRun({ ...baseValues, sourceMode });
      return context.runStructured(nodeRun.id, {
        task: sopSelectionPrompt(
          context.run,
          context.run.sharedState.projectMatchResult,
          catalog.sopCatalogSummary,
          "reference"
        ),
        outputSchema: SOP_SELECTION_SCHEMA,
        outputDescription: "Return the confirmed ordered SOP process-source selection.",
        approvalMode: "full_access",
        allowedToolNames: []
      });
    },
    structuredResult(output, context) {
      const catalog = outputRecord(context.run, "prepare-catalog");
      const canonicalOutput = canonicalizeSopSelectionV3(
        output,
        catalog.sopCatalogSummary
      );
      return {
        summary: "已确认 SOP 流程来源。",
        output: canonicalOutput,
        artifacts: [],
        statePatch: { sopProcessSelection: canonicalOutput }
      };
    },
    resolveClarification(answer, context) {
      const kind = context.nodeRun.input.graphClarificationKind;
      if (kind === "sop-source-mode") return resolveSopSourceModeV3(answer);
      if (
        kind === "custom-process-list"
        || kind === "custom-process-single-confirmation"
        || kind === "custom-process-duplicate-confirmation"
      ) {
        return resolveCustomProcessClarificationV3(answer, context.run, context.nodeRun.input);
      }
      throw new Error("Unknown deterministic SOP Source clarification.");
    }
  },
  {
    id: "resolve-processes",
    title: "Resolve Processes",
    type: "hybrid",
    execute: executeProcesses,
    structuredResult(output, context) {
      return processSubmission(
        output,
        requiredRoute(context.run.sharedState.processResolutionRoute),
        "已完成语义 Process 解析。"
      );
    }
  },
  {
    id: "generate-sop",
    title: "Generate CKD SOP Excel",
    type: "script",
    async execute(context) {
      const run = context.run;
      const catalog = outputRecord(run, "prepare-catalog");
      const normalized = requiredRecord(run.sharedState.normalizedInputs, "normalizedInputs");
      return context.executeScriptNode({
        script: "create-ckd-sop-v3",
        final: true,
        values: {
          normalizedInputs: run.sharedState.normalizedInputs!,
          projectMatchResult: run.sharedState.projectMatchResult!,
          processPlans: run.sharedState.processesMatchResult!,
          catalogPath: catalog.catalogPath as JsonValue,
          catalogHash: catalog.catalogHash as JsonValue,
          normalizationWarnings: normalized.warnings as JsonValue,
          sopProcessSelection: run.sharedState.sopProcessSelection!
        },
        outputSchema: SCRIPT_OUTPUT_SCHEMAS["create-ckd-sop-v3"]!,
        timeoutSeconds: 120
      });
    }
  }
];

export const createCkdSopV3GraphWorkflow: GraphWorkflowDefinition<CreateCkdSopGraphInput> = {
  name: "create-ckd-sop-v3",
  title: "Create CKD SOP V3",
  description: "Create a CKD SOP workbook from the process-centered Library with target-Project/common content overlays.",
  inputSchema: {
    type: "object",
    properties: {
      sopType: {
        type: "string",
        title: "SOP Type",
        description: "The isolated CKD process category used for all Project, SOP, and Process matching.",
        enum: ["assemble", "assembly_test", "pcba_test", "aging_test", "factory_test"],
        default: "assembly_test"
      },
      templateLanguage: {
        type: "string",
        title: "Template Language",
        description: "Choose the language of the generated SOP workbook template. Source content is not translated.",
        enum: ["English", "中文"],
        default: "English"
      },
      projectName: {
        type: "string",
        title: "Project Name",
        description: "The CKD project to create the SOP for.",
        minLength: 1,
        maxLength: 200
      },
      factoryTestProcesses: {
        type: "array",
        title: "Factory Test Processes",
        description: "Search the available Process Catalog, add the required Processes, and arrange their SOP order.",
        items: { type: "string", maxLength: 120 },
        minItems: 1,
        maxItems: 30
      },
      documentNumber: {
        type: "string",
        title: "Document Number",
        description: "The document number written into the generated SOP.",
        minLength: 1,
        maxLength: 200
      },
      sopName: {
        type: "string",
        title: "SOP Name",
        description: "The name of the SOP to generate.",
        minLength: 1,
        maxLength: 200
      },
      author: {
        type: "string",
        title: "Author",
        description: "The author name written on the Cover and every generated Process sheet.",
        minLength: 1,
        maxLength: 200
      }
    },
    required: ["projectName", "documentNumber", "sopName", "author"],
    additionalProperties: false
  },
  nodes,
  scriptNames: CREATE_CKD_SOP_SCRIPT_NAMES,
  validateInputs,
  nextNode(_run, completedNodeId) {
    const index = CREATE_CKD_SOP_GRAPH_NODE_IDS.indexOf(completedNodeId as CreateCkdSopGraphNodeId);
    return index >= 0 ? CREATE_CKD_SOP_GRAPH_NODE_IDS[index + 1] : undefined;
  }
};

function resolveSopSourceModeV3(answer: string): GraphClarificationResolution {
  const sourceMode = answer === "手动输入 SOP Processes"
    ? "custom"
    : answer === "参考 Library 中已有 SOP"
      ? "reference"
      : undefined;
  if (!sourceMode) throw new Error("Unsupported SOP Source selection.");
  return {
    result: {
      summary: sourceMode === "custom"
        ? "已选择手动输入 SOP Processes。"
        : "已选择参考 Library 中已有 SOP。",
      output: { sourceMode },
      artifacts: [],
      statePatch: {
        sopSourceMode: sourceMode,
        ...(sourceMode === "custom" ? {
          customProcessCollection: customProcessCollectionValue({ stage: "collect", processList: [] })
        } : {})
      }
    },
    repeatNode: true
  };
}

export function customProcessClarificationV3(
  run: GraphWorkflowRun,
  collectionInput?: JsonValue | CustomProcessCollectionState
): { kind: string; request: GraphClarificationRequest } {
  const collection = readCustomProcessCollection(collectionInput);
  if (collection.stage === "confirm-single") {
    return {
      kind: "custom-process-single-confirmation",
      request: {
        question: "是否还有更多 Process 需要添加，或已输入完毕？",
        options: [customProcessDoneOption(collection.processList), CUSTOM_PROCESS_CONTINUE_OPTION],
        allowFreeText: false,
        answerRequired: true
      }
    };
  }
  if (collection.stage === "confirm-duplicates") {
    const duplicates = duplicateProcessNames([
      ...collection.processList,
      ...(collection.pendingProcessList ?? [])
    ]);
    return {
      kind: "custom-process-duplicate-confirmation",
      request: {
        question: `检测到重复的 Process：${duplicateProcessSummary(duplicates)}。SOP 流程列表不能包含重复项，请确认如何处理。`,
        options: [customProcessRemoveDuplicatesOption(collection), CUSTOM_PROCESS_REENTER_OPTION],
        allowFreeText: false,
        answerRequired: true
      }
    };
  }
  return {
    kind: "custom-process-list",
    request: {
      question: customProcessCollectionQuestion(String(run.inputs.sopName ?? ""), collection),
      options: [],
      allowFreeText: true,
      answerRequired: true,
      inputUi: {
        widget: "ordered-string-list-dialog",
        title: "Build SOP Process Sequence",
        description: "Add one Process per row, then drag them into the exact SOP execution order. Confirming submits the same ordered text list to the existing matching workflow.",
        itemLabel: "Process",
        placeholder: "Enter a Process name",
        addLabel: "Add Process",
        minItems: 1,
        maxItems: CUSTOM_PROCESS_LIMIT,
        maxLength: CUSTOM_PROCESS_NAME_LIMIT
      }
    }
  };
}

export function resolveCustomProcessClarificationV3(
  answer: string,
  run: GraphWorkflowRun,
  nodeInput: Record<string, JsonValue>
): GraphClarificationResolution {
  const kind = nodeInput.graphClarificationKind;
  const collection = readCustomProcessCollection(nodeInput.customProcessCollection);
  if (kind === "custom-process-list") {
    const parsed = parseCustomProcessBatch(answer);
    if (parsed.error) {
      return repeatCustomProcessCollection({
        stage: "collect",
        processList: collection.processList,
        error: parsed.error
      }, parsed.error);
    }
    const pendingProcessList = parsed.processList!;
    if (collection.processList.length + pendingProcessList.length > CUSTOM_PROCESS_LIMIT) {
      const error = `Process 总数不能超过 ${CUSTOM_PROCESS_LIMIT} 个；目前已记录 ${collection.processList.length} 个，本次输入 ${pendingProcessList.length} 个。`;
      return repeatCustomProcessCollection({
        stage: "collect",
        processList: collection.processList,
        error
      }, error);
    }
    const combined = [...collection.processList, ...pendingProcessList];
    if (duplicateProcessNames(combined).length > 0) {
      return repeatCustomProcessCollection({
        stage: "confirm-duplicates",
        processList: collection.processList,
        pendingProcessList,
        afterDuplicateAction: pendingProcessList.length === 1 ? "confirm-single" : "complete"
      }, "检测到重复的 Process，等待用户确认处理方式。");
    }
    if (pendingProcessList.length === 1) {
      return repeatCustomProcessCollection({
        stage: "confirm-single",
        processList: combined
      }, `已收到 1 个 Process；当前共 ${combined.length} 个，等待用户确认是否完成。`);
    }
    return completeCustomProcessCollection(run, combined);
  }
  if (kind === "custom-process-single-confirmation") {
    if (answer === customProcessDoneOption(collection.processList)) {
      return completeCustomProcessCollection(run, collection.processList);
    }
    if (answer === CUSTOM_PROCESS_CONTINUE_OPTION) {
      return repeatCustomProcessCollection({
        stage: "collect",
        processList: collection.processList
      }, `继续补充 Process；当前已记录 ${collection.processList.length} 个。`);
    }
    throw new Error("Unsupported single-Process confirmation answer.");
  }
  if (kind === "custom-process-duplicate-confirmation") {
    if (answer === CUSTOM_PROCESS_REENTER_OPTION) {
      return repeatCustomProcessCollection({
        stage: "collect",
        processList: collection.processList,
        error: "上次输入包含重复项，已保留此前列表；请重新输入本次内容。"
      }, "已返回重新输入重复的 Process。");
    }
    if (answer !== customProcessRemoveDuplicatesOption(collection)) {
      throw new Error("Unsupported duplicate-Process confirmation answer.");
    }
    const combined = deduplicateProcessNames([
      ...collection.processList,
      ...(collection.pendingProcessList ?? [])
    ]);
    if (collection.afterDuplicateAction === "confirm-single") {
      return repeatCustomProcessCollection({
        stage: "confirm-single",
        processList: combined
      }, `已移除重复项；当前共 ${combined.length} 个 Process，等待用户确认是否完成。`);
    }
    return completeCustomProcessCollection(run, combined);
  }
  throw new Error("Unknown deterministic custom Process clarification.");
}

function customProcessCollectionQuestion(
  sopName: string,
  collection: CustomProcessCollectionState
): string {
  const error = collection.error ? `上次输入未接受：${collection.error}\n\n` : "";
  if (collection.processList.length > 0) {
    return `${error}目前已记录 ${collection.processList.length} 个 Process。请继续输入剩余的 Process：每一行只写一个 Process 名称，并按照 SOP 的执行顺序填写。你可以一次输入多行，也可以本次只输入一行；如果只输入一行，系统仍会再次确认是否已经完成。Process 总数最多 30 个。`;
  }
  return `${error}请为 SOP「${sopName}」输入 Process 流程列表。\n\n输入规则：\n1. 请按照 SOP 的执行顺序填写，每一行只写一个 Process 名称。\n2. 可以一次输入多行，也可以每次只输入一行；如果本次只输入一行，系统会再次确认是否已经完成。\n3. 最多支持 30 个 Process。\n\n示例：\n安装 MTK FLASH 驱动\n下载软件\n写入 SN`;
}

function parseCustomProcessBatch(answer: string): { processList?: string[]; error?: string } {
  const processList = answer.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  if (processList.length === 0) return { error: "请至少输入一个 Process 名称。" };
  if (processList.length > CUSTOM_PROCESS_LIMIT) {
    return { error: `单次输入不能超过 ${CUSTOM_PROCESS_LIMIT} 个 Process。` };
  }
  const tooLong = processList.find((item) => item.length > CUSTOM_PROCESS_NAME_LIMIT);
  if (tooLong) {
    return { error: `每个 Process 名称不能超过 ${CUSTOM_PROCESS_NAME_LIMIT} 个字符。` };
  }
  return { processList };
}

function repeatCustomProcessCollection(
  collection: CustomProcessCollectionState,
  summary: string
): GraphClarificationResolution {
  const value = customProcessCollectionValue(collection);
  return {
    result: {
      summary,
      output: value,
      artifacts: [],
      statePatch: { customProcessCollection: value }
    },
    repeatNode: true
  };
}

function completeCustomProcessCollection(
  run: GraphWorkflowRun,
  processList: string[]
): GraphClarificationResolution {
  if (processList.length < 1 || processList.length > CUSTOM_PROCESS_LIMIT) {
    throw new Error(`Custom Process collection must contain 1 to ${CUSTOM_PROCESS_LIMIT} items.`);
  }
  if (duplicateProcessNames(processList).length > 0) {
    throw new Error("Custom Process collection cannot complete with duplicate items.");
  }
  const selection = {
    mode: "custom",
    requestedSopName: requiredText(run.inputs.sopName, "sopName"),
    processList,
    comment: `手动模式：用户手动输入 Process 清单，共 ${processList.length} 个非空名称，按输入顺序保留（无重复）。`
  } satisfies Record<string, JsonValue>;
  return {
    result: {
      summary: `已确认手动输入完成：共 ${processList.length} 个 Process。`,
      output: selection,
      artifacts: [],
      statePatch: {
        sopProcessSelection: selection,
        customProcessCollection: null
      }
    }
  };
}

function customProcessDoneOption(processList: readonly string[]): string {
  return processList.length === 1
    ? `已完成，流程列表共 1 个：${processList[0]}`
    : `已完成，流程列表共 ${processList.length} 个`;
}

function customProcessRemoveDuplicatesOption(collection: CustomProcessCollectionState): string {
  return collection.afterDuplicateAction === "confirm-single"
    ? CUSTOM_PROCESS_REMOVE_DUPLICATES_CONTINUE_OPTION
    : CUSTOM_PROCESS_REMOVE_DUPLICATES_COMPLETE_OPTION;
}

function duplicateProcessSummary(duplicates: readonly string[]): string {
  const visible = duplicates.slice(0, 5);
  return duplicates.length > visible.length
    ? `${visible.join("、")} 等 ${duplicates.length} 项`
    : visible.join("、");
}

function duplicateProcessNames(processList: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicateKeys = new Set<string>();
  const duplicates: string[] = [];
  for (const processName of processList) {
    const key = normalizedProcessName(processName);
    if (seen.has(key) && !duplicateKeys.has(key)) {
      duplicateKeys.add(key);
      duplicates.push(processName);
    }
    seen.add(key);
  }
  return duplicates;
}

function deduplicateProcessNames(processList: readonly string[]): string[] {
  const seen = new Set<string>();
  return processList.filter((processName) => {
    const key = normalizedProcessName(processName);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedProcessName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function customProcessCollectionValue(collection: CustomProcessCollectionState): JsonValue {
  return {
    stage: collection.stage,
    processList: collection.processList,
    ...(collection.pendingProcessList ? { pendingProcessList: collection.pendingProcessList } : {}),
    ...(collection.afterDuplicateAction ? { afterDuplicateAction: collection.afterDuplicateAction } : {}),
    ...(collection.error ? { error: collection.error } : {})
  };
}

function readCustomProcessCollection(value: unknown): CustomProcessCollectionState {
  if (value === undefined || value === null) return { stage: "collect", processList: [] };
  const record = requiredRecord(value, "customProcessCollection");
  const stage = record.stage;
  if (stage !== "collect" && stage !== "confirm-single" && stage !== "confirm-duplicates") {
    throw new Error("customProcessCollection.stage is invalid.");
  }
  const processList = readCustomProcessList(record.processList, "customProcessCollection.processList");
  const pendingProcessList = record.pendingProcessList === undefined
    ? undefined
    : readCustomProcessList(record.pendingProcessList, "customProcessCollection.pendingProcessList");
  const afterDuplicateAction = record.afterDuplicateAction;
  if (
    afterDuplicateAction !== undefined
    && afterDuplicateAction !== "confirm-single"
    && afterDuplicateAction !== "complete"
  ) {
    throw new Error("customProcessCollection.afterDuplicateAction is invalid.");
  }
  return {
    stage,
    processList,
    ...(pendingProcessList ? { pendingProcessList } : {}),
    ...(afterDuplicateAction ? { afterDuplicateAction } : {}),
    ...(typeof record.error === "string" && record.error.trim() ? { error: record.error.trim() } : {})
  };
}

function readCustomProcessList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => requiredText(item, `${label}[${index}]`));
}

async function executeProcesses(context: GraphNodeExecutionContext): Promise<boolean> {
  const run = context.run;
  const catalog = outputRecord(run, "prepare-catalog");
  const selection = requiredRecord(run.sharedState.sopProcessSelection, "sopProcessSelection");
  const nodeRun = context.createNodeRun({
    projectMatchResult: run.sharedState.projectMatchResult!,
    sopProcessSelection: selection as JsonValue,
    catalogSummary: catalog.catalogSummary as JsonValue
  });
  try {
    const normalizedResult = await context.executeScript({
      id: "resolve-processes:normalize",
      script: "normalize-ckd-inputs-v3",
      values: {
        sopType: run.inputs.sopType!,
        templateLanguage: run.inputs.templateLanguage ?? "English",
        projectName: run.inputs.projectName!,
        documentNumber: run.inputs.documentNumber!,
        sopName: run.inputs.sopName!,
        author: run.inputs.author ?? "",
        processList: selection.processList as JsonValue,
        projectMatchResult: run.sharedState.projectMatchResult!,
        sopProcessSelection: selection as JsonValue
      },
      outputSchema: SCRIPT_OUTPUT_SCHEMAS["normalize-ckd-inputs-v3"]!,
      timeoutSeconds: 120
    });
    const normalized = requiredRecord(normalizedResult.output, "normalizedInputs");
    const route = processResolutionRoute(normalized);
    context.patchSharedState({
      normalizedInputs: normalized as JsonValue,
      processResolutionRoute: route
    });
    const values = processResolutionValues(run, catalog, selection, normalized);
    if (route === "semantic-agent") {
      if (run.inputs.sopType === "factory_test") {
        const exactResult = deterministicFactoryTestProcessResult(values);
        if (exactResult) {
          context.completeNode(nodeRun.id, processSubmission(
            exactResult,
            route,
            "已按 Factory Test Process Catalog 中的唯一精确项确定流程顺序，无需模型重新匹配。"
          ));
          return true;
        }
      }
      return context.runStructured(nodeRun.id, {
        task: semanticProcessesPrompt(run, values),
        outputSchema: PROCESS_RESULT_SCHEMA,
        outputDescription: "Return one ordered, resolved Process decision for every requested Process.",
        approvalMode: "full_access",
        allowedToolNames: []
      });
    }
    const script = route === "same-project-reference"
      ? "resolve-ckd-reference-processes-v3"
      : "resolve-ckd-transplant-reference-processes-v3";
    const resolved = await context.executeScript({
      id: `resolve-processes:${route}`,
      script,
      values,
      outputSchema: SCRIPT_OUTPUT_SCHEMAS[script]!,
      timeoutSeconds: 30
    });
    context.completeNode(nodeRun.id, processSubmission(resolved.output, route, resolved.summary));
    return true;
  } catch (error) {
    context.failNode(nodeRun.id, error);
    return false;
  }
}

function deterministicFactoryTestProcessResult(
  values: Record<string, JsonValue>
): JsonValue | undefined {
  const requested = Array.isArray(values.processList)
    ? values.processList.filter((value): value is string => typeof value === "string")
    : [];
  if (requested.length === 0) return undefined;
  const project = requiredRecord(values.projectMatchResult, "projectMatchResult");
  const targetProjectId = requiredText(project.matchedProjectId, "matchedProjectId");
  const targetProjectName = requiredText(project.matchedProjectName, "matchedProjectName");
  const catalog = requiredRecord(values.catalogSummary, "catalogSummary");
  const candidates = Array.isArray(catalog.processes)
    ? catalog.processes.filter((candidate): candidate is Record<string, unknown> => (
      typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ))
    : [];
  const resolvedIds = new Set<string>();
  const processes: JsonValue[] = [];
  for (const requestedProcess of requested) {
    const key = normalizedProcessName(requestedProcess);
    const matches = candidates.filter((candidate) => {
      const aliases = Array.isArray(candidate.aliases)
        ? candidate.aliases.filter((alias): alias is string => typeof alias === "string")
        : [];
      const names = [candidate.processId, candidate.displayName, ...aliases]
        .filter((name): name is string => typeof name === "string");
      if (!names.some((name) => normalizedProcessName(name) === key)) return false;
      const availability = candidate.availability && typeof candidate.availability === "object"
        && !Array.isArray(candidate.availability)
        ? candidate.availability as Record<string, unknown>
        : {};
      const projectIds = Array.isArray(availability.projectIds)
        ? availability.projectIds.filter((id): id is string => typeof id === "string")
        : [];
      return availability.common === true || projectIds.includes(targetProjectId);
    });
    if (matches.length !== 1) return undefined;
    const match = matches[0]!;
    const processId = requiredText(match.processId, "catalog processId");
    const displayName = requiredText(match.displayName, "catalog displayName");
    if (resolvedIds.has(processId)) return undefined;
    resolvedIds.add(processId);
    const projectOverviews = match.projectOverviews && typeof match.projectOverviews === "object"
      && !Array.isArray(match.projectOverviews)
      ? match.projectOverviews as Record<string, unknown>
      : {};
    const projectOverview = typeof projectOverviews[targetProjectId] === "string"
      ? projectOverviews[targetProjectId].trim()
      : "";
    const commonOverview = typeof match.overview === "string" ? match.overview.trim() : "";
    processes.push({
      requestedProcess,
      resolvedProcessId: processId,
      resolvedProcessName: displayName,
      overview: (projectOverview || commonOverview).slice(0, 200),
      status: "direct",
      sourceProjectId: targetProjectId,
      sourceProjectName: targetProjectName,
      confidence: 1,
      comment: "用户从 Factory Test Process Catalog 中选择了唯一精确项。",
      semanticMatch: "equivalent",
      semanticReason: "所选名称或 ID 与当前类型 Catalog 中唯一可用的 Process 完全一致。",
      warnings: []
    });
  }
  return { processes };
}

function validateInputs(input: CreateCkdSopGraphInput): Record<string, JsonValue> {
  const sopType = input.sopType?.trim() || "assembly_test";
  if (!["assemble", "assembly_test", "pcba_test", "aging_test", "factory_test"].includes(sopType)) {
    throw new Error("SOP Type must be assemble, assembly_test, pcba_test, aging_test, or factory_test.");
  }
  const templateLanguage = input.templateLanguage?.trim() || "English";
  if (!["English", "中文"].includes(templateLanguage)) {
    throw new Error("Template Language must be English or 中文.");
  }
  const values: Record<string, JsonValue> = { sopType, templateLanguage };
  for (const [key, label] of [
    ["projectName", "Project Name"],
    ["documentNumber", "Document Number"],
    ["sopName", "SOP Name"],
    ["author", "Author"]
  ] as const) {
    const rawValue = input[key]?.trim();
    const value = key === "author"
      ? rawValue?.replace(/^Author\s*:\s*/iu, "").trim()
      : rawValue;
    if (!value) throw new Error(`${label} is required.`);
    if (value.length > 200) throw new Error(`${label} must not exceed 200 characters.`);
    values[key] = value;
  }
  if (sopType === "factory_test") {
    values.factoryTestProcesses = readFactoryTestProcessList(input.factoryTestProcesses);
  }
  return values;
}

function readFactoryTestProcessList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CUSTOM_PROCESS_LIMIT) {
    throw new Error(`Factory Test Processes must contain 1 to ${CUSTOM_PROCESS_LIMIT} items.`);
  }
  const processList = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Factory Test Process ${index + 1} must be a non-empty string.`);
    }
    const processName = item.trim();
    if (processName.length > CUSTOM_PROCESS_NAME_LIMIT) {
      throw new Error(`Factory Test Process ${index + 1} must not exceed ${CUSTOM_PROCESS_NAME_LIMIT} characters.`);
    }
    return processName;
  });
  if (duplicateProcessNames(processList).length > 0) {
    throw new Error("Factory Test Processes cannot contain duplicate names.");
  }
  return processList;
}

function processResolutionValues(
  run: GraphWorkflowRun,
  catalog: Record<string, unknown>,
  selection: Record<string, unknown>,
  normalized: Record<string, unknown>
): Record<string, JsonValue> {
  return {
    projectMatchResult: run.sharedState.projectMatchResult!,
    processList: normalized.processList as JsonValue,
    catalogSummary: catalog.catalogSummary as JsonValue,
    catalogDetails: catalog.catalogDetails as JsonValue,
    sopCatalogSummary: catalog.sopCatalogSummary as JsonValue,
    sopProcessSelection: selection as JsonValue
  };
}

function processSubmission(
  output: JsonValue,
  route: ProcessResolutionRoute,
  summary: string
): WorkflowStepSubmission {
  const record = requiredRecord(output, "process-resolution output");
  if (!Array.isArray(record.processes)) throw new Error("Process resolution did not return processes.");
  return {
    summary,
    output,
    artifacts: [],
    statePatch: {
      processesMatchResult: record.processes as JsonValue,
      processResolutionRoute: route
    }
  };
}

function outputRecord(run: GraphWorkflowRun, nodeId: string): Record<string, unknown> {
  return requiredRecord(run.nodeOutputs[nodeId]?.output, `${nodeId}.output`);
}

export function canonicalizeSopSelectionV3(output: JsonValue, sopCatalogSummary: unknown): JsonValue {
  const selection = requiredRecord(output, "SOP selection output");
  if (selection.mode !== "reference") return output;

  const referenceProjectId = requiredText(selection.referenceProjectId, "referenceProjectId");
  const referenceSopId = requiredText(selection.referenceSopId, "referenceSopId");
  const catalog = requiredRecord(sopCatalogSummary, "sopCatalogSummary");
  const sops = Array.isArray(catalog.sops) ? catalog.sops : [];
  const selectedSop = sops.find((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    return record.projectId === referenceProjectId && record.sopId === referenceSopId;
  });
  if (typeof selectedSop !== "object" || selectedSop === null || Array.isArray(selectedSop)) {
    throw new Error("The selected Library SOP could not be verified in the frozen SOP Catalog.");
  }

  const sop = selectedSop as Record<string, unknown>;
  if (!Array.isArray(sop.processSequence) || sop.processSequence.length < 1 || sop.processSequence.length > 30) {
    throw new Error("The selected Library SOP has an invalid frozen Process sequence.");
  }
  const processSequence = sop.processSequence.map((candidate, index) => {
    const process = requiredRecord(candidate, `processSequence[${index}]`);
    return {
      processId: requiredText(process.processId, `processSequence[${index}].processId`),
      displayName: requiredText(process.displayName, `processSequence[${index}].displayName`)
    };
  });

  return {
    ...(selection as Record<string, JsonValue>),
    referenceProjectId: requiredText(sop.projectId, "selectedSop.projectId"),
    referenceProjectName: requiredText(sop.projectName, "selectedSop.projectName"),
    referenceSopId: requiredText(sop.sopId, "selectedSop.sopId"),
    referenceSopName: requiredText(sop.displayName, "selectedSop.displayName"),
    processList: processSequence.map((process) => process.displayName),
    referenceProcessIds: processSequence.map((process) => process.processId)
  };
}

export function deterministicExactProjectMatchV3(
  requestedProjectName: unknown,
  catalogProjects: unknown
): JsonValue | undefined {
  const requested = normalizedExactProjectName(requestedProjectName);
  if (!requested) return undefined;
  const catalog = requiredRecord(catalogProjects, "catalogProjects");
  const projects = Array.isArray(catalog.projects) ? catalog.projects : [];
  const matches = projects.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return [];
    const project = candidate as Record<string, unknown>;
    const projectId = typeof project.projectId === "string" ? project.projectId.trim() : "";
    const displayName = typeof project.displayName === "string" ? project.displayName.trim() : "";
    if (!projectId || !displayName) return [];
    const names = [projectId, displayName, ...(Array.isArray(project.aliases) ? project.aliases : [])];
    return names.some((name) => normalizedExactProjectName(name) === requested)
      ? [{ projectId, displayName }]
      : [];
  });
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  return {
    requestedProjectName: typeof requestedProjectName === "string" ? requestedProjectName.trim() : "",
    matchedProjectId: match.projectId,
    matchedProjectName: match.displayName,
    status: "semantic_match",
    confidence: 1,
    comment: "项目 ID、名称或别名与 Library 中的唯一项目精确匹配。"
  };
}

function normalizedExactProjectName(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().toLocaleLowerCase("en-US") : "";
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredRoute(value: JsonValue | undefined): ProcessResolutionRoute {
  if (value === "same-project-reference" || value === "cross-project-reference" || value === "semantic-agent") {
    return value;
  }
  throw new Error("Process resolution route is missing.");
}
