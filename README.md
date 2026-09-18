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
import { createAgentRuntime, SessionManager } from "pi-patrick";

const runtime = await createAgentRuntime();
const session = await runtime.createSession();

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Hello");
session.dispose();
```

## Product Query API

Set a separate HTTP API key in `.env`:

```env
PRODUCT_API_KEY=replace-with-a-random-secret
HOST=127.0.0.1
PORT=3000
```

Build and start the server:

```bash
npm run build
npm start
```

Query the product expert Skill:

```bash
curl http://127.0.0.1:3000/v1/product/query \
  -H "Authorization: Bearer $PRODUCT_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"query":"What is the IP rating of the DT50?"}'
```

Each request uses a new in-memory session and returns the final answer as JSON.

Each call to `runtime.createSession()` returns an isolated Pi `AgentSession` directly, with its complete state, events, controls, session ID, and JSONL session file. A single `AgentRuntime` shares model configuration while allowing multiple conversations to run independently.

To resume the most recent conversation:

```ts
const sessionManager = SessionManager.continueRecent(
  runtime.config.cwd,
  runtime.config.sessionsDir,
);
const session = await runtime.createSession(sessionManager);
```

## Structure

- `src/agent`: runtime, isolated Pi sessions, resource assembly, and a complete event reference.
- `src/prompts`: prompt loading and composition logic.
- `resources/prompts`: prompt content stored as Markdown.
- `src/extensions`: the composition layer for tools, commands, and hooks.
- `src/tools`, `src/commands`, `src/hooks`: intentionally empty registration points.
- `src/server.ts`: minimal authenticated HTTP product-query API.
- `src/integrations`: protocol and external-service adapters such as MCP.
- `src/memory`: long-term memory boundary.
