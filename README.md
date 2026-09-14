# Pi Patrick

An atomic personal-agent library built on the Pi Coding Agent SDK.

The core is independent of HTTP, browsers, React, and other user interfaces. It supports OpenAI-compatible Chat Completions models such as Qwen on Bailian and DeepSeek V4.

## Configuration

```bash
cp .env.example .env
```

Set the three required values:

```env
API_KEY=your-key
BASE_URL=https://api.deepseek.com
MODEL_ID=deepseek-v4-pro
```

Pi Patrick always uses the `openai-completions` protocol. `BASE_URL` must not include `/chat/completions`.

## Usage

```ts
import { createPatrickRuntime } from "pi-patrick";

const runtime = await createPatrickRuntime();
const session = await runtime.createSession();

session.subscribe((event) => {
  if (event.type === "assistant_delta") process.stdout.write(event.text);
});

await session.prompt("Hello");
session.dispose();
```

Each call to `runtime.createSession()` creates an isolated Pi `AgentSession` with its own session ID and JSONL session file. A single `PatrickRuntime` shares model configuration while allowing multiple conversations to run independently.

To resume the most recent conversation:

```ts
const session = await runtime.createSession({
  target: { type: "continue-recent" },
});
```

## Structure

- `src/agent`: runtime, isolated sessions, Pi resource assembly, and event translation.
- `src/prompts`: prompt loading and composition logic.
- `resources/prompts`: prompt content stored as Markdown.
- `src/extensions`: the composition layer for tools, commands, and hooks.
- `src/tools`, `src/commands`, `src/hooks`: intentionally empty registration points.
- `src/integrations`: protocol and external-service adapters such as MCP.
- `src/memory`: long-term memory boundary.

The optional HTTP server and React UI live on the `web` branch.
