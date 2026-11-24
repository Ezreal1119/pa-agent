import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, defineTool,
  type AgentSession, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../config.js";
import type { Delegation } from "../sub-agents/delegation.js";
import { SubAgentTasks, type ParentBinding } from "../sub-agents/tasks.js";
import { runChildModel } from "../sub-agents/model.js";
import { readyWindowsWorkspace } from "./config.js";
import { WINDOWS_FINISH_TOOL, windowsAnswerSchema, type WindowsAnswer, type WindowsToolsResult } from "./tool.js";
import { windowsReadTools } from "./read-tools.js";

export class WindowsToolsService {
  private readonly tasks: SubAgentTasks;
  constructor(private config: AgentConfig, private models: ModelRuntime) {
    this.tasks = new SubAgentTasks(config.windowsTools);
  }

  run(parentId: string, question: string, input: Delegation, binding: ParentBinding, signal?: AbortSignal, effort?: AgentSession["thinkingLevel"]) {
    const settings = this.config.windowsTools;
    if (JSON.stringify(input).length > settings.maxContextChars) throw new Error("Windows Tools task background is too long.");
    return this.tasks.run(parentId, binding, signal, async task => {
      const result: WindowsToolsResult = {...task.receipt, answer: "", sources: [], unknowns: [], questions: [], status: "failed"};
      let session: AgentSession | undefined;
      try {
        await task.enter();
        const root = readyWindowsWorkspace(settings.workspace);
        const model = this.models.getModel("openai-compatible", this.config.model.modelId);
        if (!model) throw new Error("Windows Tools model is unavailable.");
        const settingsManager = SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false}, httpIdleTimeoutMs: settings.timeoutMs});
        const loader = new DefaultResourceLoader({
          cwd: root, agentDir: this.config.agentDir, settingsManager, systemPrompt: settings.prompt,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        });
        await loader.reload();
        const evidence: WindowsAnswer["sources"] = [];
        const tools = windowsReadTools(root, task.signal, source => evidence.push(source), () => {
          task.signal.throwIfAborted();
          if (result.toolCalls >= settings.maxToolCalls) throw new Error("Windows Tools read budget reached. Submit the evidence collected so far.");
          result.toolCalls++;
        });
        let answer: WindowsAnswer | undefined;
        tools.push(defineTool({
          ...WINDOWS_FINISH_TOOL, parameters: windowsAnswerSchema,
          async execute(_id, args) {
            task.signal.throwIfAborted();
            if (answer) throw new Error("The diagnosis has already been submitted.");
            if (args.status === "completed" && !args.sources.length ||
                args.sources.some(source => source.endLine < source.startLine || !evidence.some(page =>
                  page.path === source.path && page.startLine <= source.startLine && page.endLine >= source.endLine))) {
              throw new Error("Cite workspace-relative paths and line ranges returned by read during this task.");
            }
            answer = structuredClone(args);
            return {content: [{type: "text", text: "Diagnosis submitted."}], details: {}};
          },
        }));
        ({ session } = await createAgentSession({
          cwd: root, agentDir: this.config.agentDir, modelRuntime: this.models, model,
          sessionManager: SessionManager.inMemory(root), settingsManager, resourceLoader: loader,
          tools: tools.map(tool => tool.name), customTools: tools, thinkingLevel: effort ?? "medium",
        }));
        session.agent.toolExecution = "sequential";
        session.agent.shouldStopAfterTurn = () => Boolean(answer) || task.signal.aborted;
        await runChildModel({
          session, task, source: "windows-tools", dataDir: this.config.dataDir, model: this.config.model,
          effort, maxRequests: settings.maxModelRequests, prompt: JSON.stringify({ question, delegation: input }),
        });
        if (!answer) throw new Error("Windows Tools did not submit a diagnosis.");
        Object.assign(result, answer);
      } catch {
        result.status = task.closing() ? "interrupted" : task.signal.aborted ? "cancelled" : "failed";
        result.answer = task.signal.reason?.name === "TimeoutError" ? "Windows 工具排障超时，可以缩小查询范围后重试。"
          : task.signal.aborted ? "Windows 工具排障已停止。" : "Windows 工具排障未完成，请检查资料目录或缩小查询范围后重试。";
      } finally {
        session?.dispose();
        result.elapsedMs = task.elapsed();
      }
      return result;
    });
  }

  deleteParent(id: string) { return this.tasks.deleteParent(id); }
  close() { return this.tasks.close(); }
  dispose() { this.tasks.dispose(); }
}
