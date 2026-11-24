import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../config.js";
import type { Delegation } from "../sub-agents/delegation.js";
import { SubAgentTasks, type ParentBinding } from "../sub-agents/tasks.js";
import { runChildModel } from "../sub-agents/model.js";
import { installToolBudget } from "../agent/tool-budget.js";
import { readyWindowsWorkspace } from "./config.js";
import { WINDOWS_ANSWER_CHARS, type WindowsToolsResult } from "./tool.js";
import { windowsReadTools } from "./read-tools.js";
import type { WindowsAttachment } from "./attachments.js";

export class WindowsToolsService {
  private readonly tasks: SubAgentTasks;
  constructor(private config: AgentConfig, private models: ModelRuntime) {
    this.tasks = new SubAgentTasks(config.windowsTools);
  }

  run(parentId: string, question: string, input: Delegation, binding: ParentBinding, signal?: AbortSignal, effort?: AgentSession["thinkingLevel"], attachments: readonly WindowsAttachment[] = []) {
    const settings = this.config.windowsTools;
    if (JSON.stringify(input).length > settings.maxContextChars) throw new Error("Windows Tools task background is too long.");
    return this.tasks.run(parentId, binding, signal, async task => {
      const result: WindowsToolsResult = {...task.receipt, answer: "", status: "failed"};
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
        const tools = windowsReadTools(root, task.signal, () => {
          task.signal.throwIfAborted();
          result.toolCalls++;
        }, attachments);
        ({ session } = await createAgentSession({
          cwd: root, agentDir: this.config.agentDir, modelRuntime: this.models, model,
          sessionManager: SessionManager.inMemory(root), settingsManager, resourceLoader: loader,
          tools: tools.map(tool => tool.name), customTools: tools, thinkingLevel: effort ?? "medium",
        }));
        session.agent.toolExecution = "sequential";
        session.agent.shouldStopAfterTurn = () => task.signal.aborted;
        installToolBudget(session, {
          lastRequest: () => result.usage.requests >= settings.maxModelRequests - 1,
        });
        await runChildModel({
          session, task, source: "windows-tools", dataDir: this.config.dataDir, model: this.config.model,
          effort, maxRequests: settings.maxModelRequests, prompt: JSON.stringify({
            question, delegation: input,
            ...(attachments.length ? {attachments: attachments.map(({path, name, bytes}) => ({path, name, bytes}))} : {}),
          }),
        });
        const last = session.messages.findLast(message => message.role === "assistant");
        const text = last?.role === "assistant" && last.stopReason !== "error" && last.stopReason !== "aborted"
          ? last.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n").trim() : "";
        if (!text) {
          console.info("[windows-tools] no diagnostic text", {taskId: result.taskId, stopReason: last?.stopReason});
          throw new Error("Windows Tools did not return usable analysis.");
        }
        const partial = last?.stopReason !== "stop" || text.length > WINDOWS_ANSWER_CHARS;
        result.status = partial ? "partial" : "completed";
        result.answer = text.slice(0, WINDOWS_ANSWER_CHARS) + (partial ? "\n\n（以上为子 Agent 返回的部分分析。）" : "");
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
