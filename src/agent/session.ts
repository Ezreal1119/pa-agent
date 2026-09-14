import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type PatrickEvent,
  type PatrickMessage,
  type PatrickSessionState,
  translateAgentEvent,
} from "./events.js";

export type PatrickEventListener = (event: PatrickEvent) => void;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function toPatrickMessages(messages: AgentSession["messages"]): PatrickMessage[] {
  return messages.flatMap((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textFromContent(message.content);
    if (!text) return [];
    return [{ id: `${message.timestamp}-${index}`, role: message.role, text }];
  });
}

export class PatrickSession {
  private readonly listeners = new Set<PatrickEventListener>();
  private unsubscribe?: () => void;

  constructor(readonly session: AgentSession) {
    this.unsubscribe = session.subscribe((event) => {
      const translated = translateAgentEvent(event);
      if (translated) this.emit(translated);

      if (event.type === "message_end" || event.type === "agent_settled") {
        this.emit({ type: "state", state: this.getState() });
      }
    });
  }

  subscribe(listener: PatrickEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): PatrickSessionState {
    const model = this.session.model;
    const hasModel = model && model.provider !== "unknown" && model.id !== "unknown";
    return {
      sessionId: this.session.sessionId,
      model: hasModel ? `${model.provider}/${model.id}` : null,
      isStreaming: this.session.isStreaming,
      messages: toPatrickMessages(this.session.messages),
    };
  }

  async prompt(text: string): Promise<void> {
    await this.session.prompt(text, {
      streamingBehavior: this.session.isStreaming ? "followUp" : undefined,
      source: "rpc",
    });
  }

  async abort(): Promise<void> {
    this.emit({ type: "status", status: "stopping" });
    await this.session.abort();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session.dispose();
  }

  private emit(event: PatrickEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
