import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface SessionState {
  sessionId: string;
  model: string | null;
  isStreaming: boolean;
  messages: Message[];
}

type RuntimeStatus = "idle" | "running" | "stopping";

type AppEvent =
  | { type: "state"; state: SessionState }
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string; name: string; isError: boolean }
  | { type: "status"; status: RuntimeStatus }
  | { type: "error"; message: string };

async function request(path: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response;
}

function statusLabel(status: RuntimeStatus): string {
  if (status === "running") return "思考中";
  if (status === "stopping") return "正在停止";
  return "空闲";
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [status, setStatus] = useState<RuntimeStatus>("idle");
  const [model, setModel] = useState("正在连接…");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string>();
  const [activeTools, setActiveTools] = useState<Record<string, string>>({});
  const [creatingSession, setCreatingSession] = useState(false);
  const conversationRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function applyEvent(event: AppEvent): void {
    switch (event.type) {
      case "state":
        setMessages(event.state.messages);
        setModel(event.state.model ?? "尚未配置模型");
        setStatus(event.state.isStreaming ? "running" : "idle");
        if (!event.state.isStreaming) setStreamingText("");
        break;
      case "assistant_delta":
        setStreamingText((current) => current + event.text);
        break;
      case "tool_start":
        setActiveTools((current) => ({ ...current, [event.id]: event.name }));
        break;
      case "tool_end":
        setActiveTools((current) => {
          const next = { ...current };
          delete next[event.id];
          return next;
        });
        break;
      case "status":
        setStatus(event.status);
        break;
      case "error":
        setError(event.message);
        setStatus("idle");
        break;
    }
  }

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onmessage = (message) => {
      try {
        applyEvent(JSON.parse(message.data) as AppEvent);
      } catch (eventError) {
        console.error("Invalid event", eventError);
      }
    };
    events.onerror = () => setModel("连接已断开，正在重试…");

    void request("/api/session")
      .then((response) => response.json() as Promise<SessionState>)
      .then((state) => applyEvent({ type: "state", state }))
      .catch((requestError: unknown) => {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      });

    return () => events.close();
  }, []);

  useEffect(() => {
    const node = conversationRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, streamingText]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;

    setError(undefined);
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: "user", text },
    ]);
    setInput("");
    setStreamingText("");
    setStatus("running");

    try {
      await request("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
      setStatus("idle");
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function abort(): Promise<void> {
    setStatus("stopping");
    try {
      await request("/api/abort", { method: "POST" });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  async function startNewSession(): Promise<void> {
    setCreatingSession(true);
    setError(undefined);
    try {
      const response = await request("/api/session/new", { method: "POST" });
      const state = (await response.json()) as SessionState;
      setStreamingText("");
      setActiveTools({});
      applyEvent({ type: "state", state });
      inputRef.current?.focus();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setCreatingSession(false);
    }
  }

  const visibleMessages = streamingText
    ? [...messages, { id: "streaming", role: "assistant" as const, text: streamingText }]
    : messages;
  const tools = Object.values(activeTools);

  return (
    <main className="shell">
      <header className="header">
        <div className="brand">
          <span className="mark">π</span>
          <div>
            <h1>Patrick</h1>
            <p>{model}</p>
          </div>
        </div>
        <button
          className="ghost"
          type="button"
          disabled={creatingSession || status !== "idle"}
          onClick={() => void startNewSession()}
        >
          {creatingSession ? "创建中…" : "新对话"}
        </button>
      </header>

      <section className="conversation" ref={conversationRef} aria-live="polite">
        {visibleMessages.length === 0 ? (
          <div className="empty">
            <span className="empty-mark">π</span>
            <h2>从这里开始</h2>
            <p>这是 Pi Patrick 的第一个可运行版本。</p>
          </div>
        ) : (
          visibleMessages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <span className="speaker">{message.role === "user" ? "你" : "π"}</span>
              <div className="bubble">{message.text}</div>
            </article>
          ))
        )}
      </section>

      {(tools.length > 0 || error) && (
        <aside className="activity">
          {tools.map((name) => (
            <span key={name}><i />正在使用 {name}</span>
          ))}
          {error && <span className="error">{error}</span>}
        </aside>
      )}

      <form className="composer" onSubmit={(event) => void submit(event)}>
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          placeholder="给 Patrick 发消息…"
          aria-label="消息"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-actions">
          <span className="status">
            <i data-status={status} />
            <span>{statusLabel(status)}</span>
          </span>
          {status !== "idle" && (
            <button className="stop" type="button" onClick={() => void abort()}>
              停止
            </button>
          )}
          <button className="send" type="submit" aria-label="发送" disabled={status === "stopping"}>
            ↑
          </button>
        </div>
      </form>
      <p className="hint">Enter 发送 · Shift + Enter 换行</p>
    </main>
  );
}
