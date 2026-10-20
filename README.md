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
runtime.dispose();
```

Each call to `runtime.createSession()` returns an isolated Pi `AgentSession`, with its state, events, controls, session ID, and JSONL session file. A single `AgentRuntime` shares model configuration while allowing multiple conversations to run independently. The runtime installs the expert loading and history policies below on every session. Send user requests with `session.prompt()`; concurrent requests to the same session are rejected, so queue them at the service layer.

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
- `src/tools`: extra-memory tool definitions plus an extension registration point; `src/commands` and `src/hooks` remain empty registration points.
- `src/integrations`: protocol and external-service adapters such as MCP.
- `src/memory`: long-term memory boundary.

A local Web testing interface now lives in `src/web` and `resources/web` on this checkout; see below.

## Default expert skills and memory

The configured data directory (`AGENT_DATA_DIR`, default `.data/`) contains the required product expert and optional UMS skill:

```text
.data/
├── ums-expert/              optional, on-demand
│   ├── SKILL.md
│   └── references/...
├── urovo-product-expert/
│   ├── SKILL.md
│   ├── product-knowledge-vault/...
│   └── <product>/...
├── memory/
│   └── urovo-product-expert/
│       ├── MEMORY.md         required, read-only main memory
│       └── MEMORY_EXTRA.md   optional, writable by the memory tool
├── agent/
└── sessions/
```

Only `urovo-product-expert/SKILL.md` and `memory/urovo-product-expert/MEMORY.md` are required and read anew for each user request, including resumed sessions. The product expert’s absolute root and full contents are injected at the model request boundary. All model/tool steps within that run share the same snapshot; edits take effect on the next request without restarting the runtime. Missing, unreadable, or empty files stop execution before inference. They are not repeatedly appended to the persisted transcript. Business memory is data; it does not grant tool permissions.

Both skill templates instruct the model to omit sources, file paths, citation markers, and reference lists from final answers unless the user explicitly requests sources or references. Retrieval and verification still happen internally, and relevant uncertainty or conflicting facts should still be explained. This is a skill instruction rather than a frontend filter; it does not rewrite earlier replies.

Versioned skill templates live in `resources/skills/`. Deploy the product template and its knowledge under `urovo-product-expert/`, with main memory under `memory/urovo-product-expert/MEMORY.md`. Optionally deploy `ums-expert/SKILL.md` and `references/`; the SDK advertises its name, description and actual deployed file path, and the agent reads its body with `read` when the user asks a relevant UMS question. UMS has no dedicated MEMORY loading step, and missing UMS files do not block product runs. An existing UMS MEMORY is retained on disk but no longer automatically read or injected. Runtime edits use the `.data/` copies; templates do not automatically overwrite them. Use configured roots rather than Mac-specific absolute paths when deploying to Linux.

Knowledge, business memories, session history, maintenance backups, and `.env` remain Git-ignored. Only code and generic skill templates belong in Git. New and resumed sessions enable Pi's built-in `read`, `grep`, `find`, and `ls`, plus the narrowly scoped `memory` tool. The independent `get_file_link_from_library` switch defaults on (six tools total when on, five when off). Optional `search` / `fetch` online tools default off and add up to two tools when enabled. Bash, PowerShell, general edit, and write are unavailable, even if the model requests an old tool from session history. Searches use tool parameters rather than shell commands/pipelines; `find` uses fd and `grep` uses ripgrep, installed or resolved by the SDK. This limits agent capabilities, but is not a filesystem sandbox: readable paths are not confined to the knowledge roots, and OS/container read-only mounts have not been added. Session/log persistence and retention continue to write from application code, independently of model tools.

### Shared extra agent memory

In addition to the product skill memory, every run injects the full `<dataDir>/memory/urovo-product-expert/MEMORY_EXTRA.md` in a separate system section, once per model request. An empty/missing extra file is valid and is not rewritten on startup; the first successful add initializes it. A run keeps its initial snapshot across tool/model steps, and the next run reloads the latest file. The extra memory is shared across this runtime's conversations and is not part of the session's 30-day retention. The product skill memory and any retained legacy skill memories remain read-only.

The single `memory` tool operates only on this fixed extra file. Its `action` parameter selects one of three operations; there is no path parameter or list/get action:

| `action` | Other parameters | Effect |
| --- | --- | --- |
| `add` | `content`, optional `kind`, `expected_revision` | Add one entry with an automatic ID, timestamps and `unknown@email.com`; do not supply `id` |
| `edit` | `id`, `content`, optional `kind`, `expected_revision` | Replace one entry's body; preserve ID, creator and creation time; update modification time |
| `delete` | `id`, `expected_revision` | Remove one entry from this file; do not supply `content` or `kind`; never delete a skill entry or the whole file |

Only the name `memory` is registered. The earlier `memory_add`/`memory_edit`/`memory_delete` names are no longer callable; their existing session records remain viewable. Entry IDs, revisions and backup formats are unchanged. Memory paths now use `memory/urovo-product-expert/{MEMORY,MEMORY_EXTRA}.md`; see [the migration steps](docs/memory-layout-migration.md). Legacy paths are not read, copied, merged or removed automatically.

The file uses the same `# Skill Memories`, `## Memory mem_…`, `Kind`, `Created-By-Email`, `Created`, `Updated`, and `### Content` format as the product skill memory. New timestamps use `+08:00`. Tool content must be nonempty, at most 64,000 characters, and cannot contain reserved `## Memory` entry headings or NUL. Arbitrary existing text is still injected, but mutation refuses malformed/duplicate entry structures rather than rewriting them.

System instructions and the tool's content description ask the model to start body headings at `###`, with `####` or deeper for subheadings, avoiding `#`/`##` inside the body. This is a soft formatting preference; it adds no heading-count or heading-depth validation, requires no heading for plain text/lists, and does not rewrite existing memories.

The model is instructed to write only when the current user explicitly asks to remember, correct or forget information. This is a model instruction, not a language-based authorization parser. Every mutation requires the SHA-256 `Revision` shown with the injected extra memory or returned by the latest successful tool call. Concurrent writes within the single service process serialize; stale versions fail with `MEMORY_CONFLICT` and return the latest revision/content for re-evaluation. Do not run multiple writer processes against the same extra file; manual edits are checked again before commit, but this is not a cross-process filesystem lock.

Each attempted commit saves the previous text under `<dataDir>/maintenance-backups/extra-memory/`, writes and syncs a temporary file, then atomically renames it. Backups/files use mode 600, and memory/backup subdirectories must not be symlinks. Linked memory files are refused. Backups are outside session retention and are not automatically pruned. The original empty file remains untouched until a real operation succeeds. The Web debug panel shows the current extra file size and verifies an extra-memory section alongside the two skill memories; tool-call details include each mutation and its resulting revision.

## Five-round context

Each inference sees at most five user rounds **including the current request**: four previous rounds plus the current one. A round includes the user's message, all assistant/tool-call/tool-result messages, and the answer. Whole rounds are dropped rather than cutting tool pairs. Legacy compaction and branch summaries are excluded, and automatic compaction is disabled so older history is not reintroduced through a summary. Different sessions never share histories.

The system instructions and full expert skills/memories are outside the five-round window and remain present for every inference. A five-round limit is not a token guarantee: large memory or tool outputs can still exceed the configured model's context. This version does not silently truncate business memory or provide automatic overflow summarization.

## Session retention

Complete JSONL transcripts stay on disk independently of the five-round inference window. The runtime removes recognized session files in its configured `sessions/` directory after **30 days since last activity**. Startup, session creation, and an hourly background sweep perform cleanup; `await runtime.cleanupSessions()` triggers an explicit sweep. The timer does not keep Node alive by itself, so a continuously running VPS service must own the runtime.

Active `session.prompt()` runs are protected from cleanup within this process, and activity is refreshed on use/completion. Sessions older than 30 days cannot be resumed to bypass expiration. If an idle loaded session has already been removed, its next prompt fails and the caller must start a new session. Unknown files, symlinks, shared knowledge, and memories are not deletion targets. Attachments and outputs under `.data/files/<sessionId>/` are removed with their expired session or on explicit session deletion, even when file tools are disabled. Active sessions are protected; current sessions retain attachments even if the attachment directory is older.

Use one service process per sessions directory; cross-process active-session locking is not implemented. Dispose sessions when finished and call `runtime.dispose()` at service shutdown to stop the maintenance timer. SessionManagers passed to this runtime must store files under its configured sessions directory.

## Verification

`npm test` builds the project and exercises the installed SDK against a local simulated model endpoint. Tests inspect actual outgoing requests, tool exchanges, fresh resource loading, resumed context, session isolation, and retention. These checks do not validate real model answer quality or a VPS deployment.

## Local Web testing interface

```bash
npm install
npm run web
```

Open `http://127.0.0.1:4321`. The server only listens on the loopback address. Set `WEB_PORT` to choose another local port. The interface runs the existing Core directly, with the same default skills, memory snapshots, five-round context, and 30-day session retention.

Before opening the workspace, set both `ADMIN_ACCOUNT` and `ADMIN_PASSWORD` in your Git-ignored `.env` (or process environment), then restart the Web server. There are no default credentials. Missing or partial configuration shows setup instructions on the login page and leaves browser Agent APIs inaccessible. The administrator account is separate from the model API key. Credentials are loaded at startup and never returned to the frontend, written to conversation history, or saved in browser storage.

Login uses an opaque HttpOnly, SameSite=Strict cookie with a fixed seven-day lifetime (604800 seconds from login; ordinary requests do not extend it). Login records are bounded and held in server memory, so restarting the server invalidates existing logins. Use **退出登录** to invalidate the current cookie on the server; the UI disables logout while its run is active. Ten failed login attempts from the same address within one minute temporarily block further attempts. This login protects the existing interface and retains one administrator role. HTTPS reverse-proxy access additionally requires an explicit `WEB_PUBLIC_URL` (see below).

Model connection settings are read from `.env`/process environment at startup. Edit `API_KEY`, `BASE_URL`, `MODEL_ID` and optional model limits there, then restart; the Web interface does not edit them. The former `/api/config` endpoint returns 410. The key is never returned by status endpoints or stored in browser storage.

**Agent settings** provides a reasoning level and individual switches for online tools, library links, and the six file tools. There are no master switches. The login, workspace, contacts, debug panels, and fixed notices use English; user messages, answers, names, and file contents retain their original language. Changes apply to subsequent requests across all sessions and persist in Git-ignored `.data/web-agent-settings.json` (mode 600), without changing `.env`. Saving is rejected while a run, session initialization or upload is active. Cached agents are reopened with the new tool selection; saved histories, names, attachments and pending drafts remain available.

Features: new/resumed conversations, streamed text, sanitized Markdown and tables, stopping a run, copying answers, and a collapsible context inspector. The inspector checks the assembled provider payload and reports the number of skill/memory copies, user rounds, model requests, and serialized request bytes. Request bytes are not token counts and payload assembly does not prove that the upstream model accepted a request. Raw memory contents, reasoning traces, and tool result bodies are not sent to the inspector.

The backend exposes a local `/api/status`, `/api/agent-settings`, `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/run`, and `/api/sessions/:id/stop`. Session detail accepts PATCH `{ "title": "..." }` and DELETE for management. These APIs require an authenticated login cookie; mutating calls additionally require the current page token. Host/Origin checks reject foreign web pages. No `.env`, arbitrary filesystem paths, or `.data` static files are served. Refreshing or closing the page interrupts its running request; persisted history remains available. The interface supports one administrator and does not add multi-user authorization.

For direct API callers, first GET `/api/auth/status` to obtain the local `token`, then POST `/api/auth/login` with JSON `{ "account": "...", "password": "..." }` and `X-Local-Token`. Retain the returned cookie for subsequent requests. GET `/api/status` and create/resume a session, then POST `/api/sessions/:id/run` with JSON `{ "text": "...", "effort": "low" }` to receive SSE. Existing token-only clients must now authenticate as well. POST `/api/auth/logout` with the cookie and local token logs out. Only the login page/assets and auth bootstrap endpoint are accessible without authentication.

The sidebar's **⋯** menu offers **重命名** and **删除**. Names are trimmed, limited to 80 characters, and saved as SDK `session_info` entries in the original JSONL, outside model context. Renaming an empty session also persists immediately. Deletion asks for confirmation, removes that JSONL (messages, tool results, and run metrics), disposes the in-memory session, and resets the active view if needed. Active/opening sessions cannot be renamed or deleted. Management resolves IDs through the server's session catalog and rejects symlink targets; it never accepts a client file path. Saved-session management does not need to initialize the model or load knowledge files.

The right-hand inspector is hidden by default at every screen size. Use **调试信息** in the top bar to open it, then close it using × or Escape. Run strength, duration, tool counts and tool inspection remain on the conversation itself. Small screens can open the conversation list with the top-left menu button.

Run `npm test` for Core and Web integration checks. Local tests use a simulated model; real model quality must be tested with your own configured endpoint.

## Global thinking effort and per-run timing

**Agent 设置** offers **快速 / 标准 / 深入 / 深度研究**, mapped to DeepSeek `off / low / high / max`. Standard (`low`) is the initial global default. The composer shows the current global value and opens Agent settings when clicked. It no longer stores a browser-only effort or sends a per-run UI override. Every run locks its selected value for all model/tool subrequests and retries. The final provider payload explicitly carries `thinking.type` and `reasoning_effort`; fast mode sends `disabled` and `none`. DeepSeek model registrations include compatible thinking mappings, `max_tokens`, and reasoning-content replay for tool calls.

The current selector is supported for the direct DeepSeek endpoint and model IDs identifying DeepSeek (including a compatible proxy). Other providers retain their existing defaults; the controls are disabled and the API rejects an explicit unsupported effort instead of pretending it applied. `/api/status` reports this capability, and `/api/sessions/:id/run` accepts an optional `effort` field. An omitted field uses the saved global effort for DeepSeek and provider defaults otherwise; explicit API effort remains supported for compatibility. The API validates effort before starting a run.

Each newly executed Web run records a unique ID, sequence, conversation round, model, selected effort, start/end times, total duration, first-text wait, and completion/failure/stop status. Total duration is measured by the backend's monotonic clock from acceptance of a valid run request, including session preparation, resource loading, tool calls, model calls, and retries. It excludes the separate creation request for a new session and browser/network overhead. First-text wait refers to the first visible assistant text, which may be an explanation before a tool call rather than the final answer.

Timing appears live beside the input, in the context inspector, on the corresponding user message after completion, and in the latest-five-run list. Start/end records use SDK custom session entries and do not enter model context or count as conversation rounds. Finished records survive page reload and server restart, and are removed with the session by the existing retention policy. Historical runs without measurements are not backfilled. If a retained start record has no finish record after a process interruption, it is shown as interrupted with unknown duration rather than an invented value.

Reasoning controls follow [DeepSeek's Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/). Lower effort does not impose a fixed response deadline or tool-call limit. Tests verify transmitted settings and persistence against a local simulated provider, not real-model latency or answer quality.

## Per-answer tool inspection

Each assistant answer shows its run's tool-call count next to **复制回答**, with **查看工具调用** opening a list of collapsible cards. Each card shows the call's sequence, tool name, argument preview, status, and measured execution duration. Expanding a card reveals its call ID, start/end times, original arguments, and recorded result/error and structured details. Tool text is rendered as plain text. Result details load on demand from `GET /api/sessions/:id/runs/:runId/tools`; the regular conversation response carries only the count and run reference, without tool bodies or reasoning traces.

Counts represent assistant tool-call blocks within the user run, including failures and calls left unfinished by interruption; they are separate from model HTTP request counts. Repeated names and multiple tool steps are counted separately, and calls remain available beyond the five-round model context window until the session expires. If a run made calls but produced no text, the conversation shows a placeholder with the same inspection entry.

Arguments/results are reconstructed from the original SDK JSONL messages. New Web runs checkpoint per-call timing in the existing custom run metadata, excluded from model context and removed with the session. Historical calls remain inspectable using a stable round reference; missing timing is shown as **耗时未记录** without migration or fabricated measurements. Already truncated SDK/tool output cannot be reconstructed beyond the stored result. A stopped or interrupted call without a result is explicitly shown without inventing its outcome. Explicit stop requests take precedence over the SDK's last assistant error when classifying the run.

## Optional file tools

Set `FILE_TOOLS_ENABLED=true` for the initial defaults, or enable individual tools in Web **Agent settings**, to add `pdf_read`, `docx_read`, `pptx_read`, `excel_read`, `excel_patch_template`, and `image_read`. The Web composer then offers uploads and authenticated attachment/output downloads. Excel patching creates a new verified workbook; the source and business memories remain protected. Two additional independent switches, **Create Excel** (`excel_create`) and **Create text file** (`text_file_create`), are initially off. They generate new comparison workbooks or UTF-8 HTML/Markdown/Java and other text attachments without a source file, execution or overwriting. Existing download cards and WeCom file delivery are reused. `npm run test:file-create` checks these creators in production mode. Existing skill/memory injection and the five-round context policy continue unchanged.

Install the pinned MarkItDown environment for local development and configure `MARKITDOWN_COMMAND`. Image recognition uses the separate `VISION_LLM_BASE_URL`, `VISION_LLM_API_KEY`, and `VISION_LLM_MODEL` fields. Ubuntu production supports native workers without Docker; use the supplied systemd service for aggregate resource limits and read-only knowledge directories. An explicitly configured worker image still selects the optional container backend. See [native VPS setup](docs/vps-native-deploy.md). See [configuration, API, supported semantics and Ubuntu deployment](docs/file-tools.md).

The initial switch defaults to false. Saved Web preferences override that initial default. Turning off all file tools omits file skills and processing while preserving existing downloads and tool history; base tools and the independent library/online choices remain available. The module does not introduce Bash or arbitrary file writes. Run `npm test` after installing file-converter dependencies; real-model and Linux checks are recorded separately in [validation history](dev-history/2026-10-18-file-tools.md).

## Per-message attachments

Uploads prepare files for the next message. Send text and up to twenty `attachmentIds` together to `/api/sessions/:id/run`; omitted IDs mean no new attachments. PDF, DOCX, XLSX, PPTX and images share this flow. The UI shows sent files beneath their user message and keeps generated outputs in a collapsible session file list. Removing a pending chip cancels sending that file; the original remains in the session directory. Pending IDs persist per session in the current browser.

The existing JSONL stores message attachment metadata, and inference receives a file brief on the corresponding user message without altering the stored user text. New unsent files are excluded from the model catalog. Five-round context and memory injection remain unchanged. Expiration and manual deletion remove all session inputs, outputs, cache and temporary files together; shared knowledge and memories are outside this cleanup.

## Agent settings API

Authenticated `GET /api/agent-settings` returns `{ settings, reasoningSupported, webToolsConfigured }`. `PUT` accepts the complete settings object with `effort`, `libraryLinks: { enabled }`, `fileTools: { tools }`, and `webTools: { tools }`; each tool map contains every tool name in its group with a boolean value. Unknown/model/credential fields are rejected. Writes also require the local request token and existing Host/Origin checks. Only enabled tool definitions reach the model, and direct execution of disabled file tools is refused. Their corresponding file skills are loaded only when needed. The current settings format has no group `enabled` fields. Legacy settings/requests with `enabled: false` migrate every item in that group to false; `enabled: true` preserves each stored choice. Old preferences do not activate tools that were previously blocked by a master switch. Internal Core module flags remain derived from whether any tool is enabled.

Existing model API clients may still provide explicit per-run `effort`. The Web always uses the global setting. Unsupported providers keep their own reasoning default; the UI disables reasoning selection while permitting tool configuration. Settings are outside session retention and contain no model credentials.

## Download generated files

Successful workbook outputs appear as download cards beneath the corresponding assistant answer, even if the answer contains no filename or path. The backend publishes and registers each file against its run/user-message/tool-call in existing JSONL custom entries. SSE `output` events deliver `{ runId, file }` before the final answer; assistant message views include `outputs` and `outputNotice` for reload/restart recovery. Multiple outputs share the same run card area.

If a later model request fails or the run is stopped, already-published files remain downloadable and the UI labels the incomplete run. Downloads use the existing authenticated session/file-ID endpoint. Legacy structured tool-result file metadata can restore existing output cards; assistant prose cannot create a file card. Files still follow session deletion/expiration and remain listed in the session file summary.

## Local debug artifacts

Keep development test logs, screenshots, fixtures, validation reports and temporary test-service data under `.data/debug/`. This directory is Git ignored and is not required for production. Runtime data (`agent/`, `sessions/`, `files/`), business knowledge and memory, the local `file-runtime/` environment, and `maintenance-backups/` stay in their existing `.data/` locations.

## Test commands

- `npm test` (or `npm run test`): build and run the complete test suite.
- `npm run test:office-xml`: build and run the Office XML encoding regression tests in production/native-worker mode. This command supports the project’s macOS/Ubuntu shell environments; it does not edit `.env`.

## WeCom on the VPS

An optional independent long-connection bridge in `integrations/wecom-bridge/` reuses the existing Agent, skills, memory and file workers through a scoped loopback machine API. Single chats isolate users; group members share one session per group. PDF/DOCX/PPTX/XLSX/images use the existing attachment pipeline, and validated Excel outputs are delivered from structured backend output metadata, without parsing answer paths.

Set `WECOM_ENABLED=true` and the Bot ID/Secret plus a dedicated `WECOM_API_TOKEN` in `.env`. The new `/api/wecom/...` API accepts only that credential and owned WeCom session IDs, without browser cookies or access to Agent settings. Browser routes retain their login and CSRF requirements. Both HTTP entry points share `AGENT_MAX_CONCURRENT_RUNS` (default 2) and a bounded waiting queue (default 8); file workers remain serial. Library/CLI callers are not governed by this HTTP gate.

Run `npm run test:wecom` for isolated transport/API and real-file-worker integration tests. Run `npm run wecom:bridge` for foreground operation after configuration. For VPS setup, install the two supplied service units and manage `product-expert.service` and `wecom-bridge.service` independently. Neither unit starts, stops or restarts the other. Full configuration, root deployment commands, recovery limits and real-bot acceptance steps: [WeCom bridge](docs/wecom-bridge.md).


## HTTPS domain access

For HTTPS reverse-proxy access, set `WEB_PUBLIC_URL=https://urovo-agent.patrick-shenzhen.cn` in the VPS `.env` (origin only, without `/login`) and restart **product-expert.service**. The listener remains on 127.0.0.1; the configured domain is an explicit Host/Origin allowance. Both preserved public Host and rewritten loopback Host are supported; client-provided forwarded headers never grant additional trust. With the field blank, the original loopback-only behavior remains.

HTTPS-domain logins/logout use Secure cookies, retaining HttpOnly, SameSite=Strict, the seven-day lifetime, and request-token checks. Local HTTP logins continue to work. The WeCom service remains separately managed and its API does not accept the public Host/Origin. Reverse proxies should exclude `/api/wecom/`; the sample also includes SSE and 30MiB upload settings. See [HTTPS proxy configuration](docs/vps-native-deploy.md#https-域名访问).

## WeCom contact notes and incoming-message notifications

The sidebar **企微联系人** lists observed sender User IDs, including members who speak in groups. Set a note per bot/user; the same person's private/group messages share that note, independently of session titles or deletion. Existing available bridge mappings/jobs seed the list, and future messages register identities through the scoped machine API. Only the Web administrator can edit notes.

Set `WECOM_NOTIFY_USER_ID` in the VPS `.env` to receive other users' incoming messages and exclude your own messages everywhere. Notifications show **对话人** using the latest note (or User ID), Beijing time, message text and attachment names/types; they omit the session-title field. They do not call the model or forward answers/tool bodies. A separate bounded durable outbox handles retries, deduplication and restart recovery without taking Agent slots. Blank configuration disables forwarding; contacts still register. Per-bot `notifyUserId` can override the global recipient. See [configuration and retention details](docs/wecom-bridge.md#企微联系人备注与消息通知).


企微联系人使用独立页面 `/wecom-contacts`（左侧入口），展示提问次数和输入/输出/总 Token。统计从升级后开始；群聊按本轮发送者归属，失败/停止也计一轮，文件单独上传不算。Token 只累加收到的 usage，缺失会标明；会话删除和30天清理不清零联系人累计。详情见 `docs/wecom-bridge.md` 的“联系人与用量统计”；本次升级需分别重启 Agent 与 Bridge。


#
## 按需联网搜索与网页读取

英文 Agent settings 提供 `search`、`fetch` 两个独立开关，无总开关，初始均关闭。与文件工具、资料库链接开关独立。设置保存到 `.data/web-agent-settings.json` 的 `webTools: { tools: { search, fetch } }`，旧设置缺少此项时默认关闭；Web、企微后续请求及重启恢复会话共用，执行中的任务须先结束才能修改。关闭的工具不注册，也不提供专用调用指导；历史记录和已返回链接保留。所有工具全部开启时最多14个。

- `search({ query, count? })`：固定 POST `https://api.deepseek.com/v1/tools/search`，默认5条、最多10条，固定 `need_content=false`。query 允许整理为必要关键词，1～128个Unicode字符；返回标题、URL、摘要；提示模型只提取必要关键词，后端不自动拼入原始问题、记忆或文档。空结果不算调用错误。
- `fetch({ url })`：固定 POST `https://api.deepseek.com/v1/tools/fetch`，返回标题与Markdown正文。只允许公开HTTP/HTTPS域名链接，拒绝带账号密码、IP字面量和明显本机/内网主机名；域名实际解析及访问由DeepSeek实施其安全策略。不会从VPS直连目标网站，也不下载文件、注册附件或保证PDF解析成功。输入URL最多8192字符，正文最多60000字符，截断时明确标记。

密钥仅由后端加入DeepSeek请求头。主模型直连 `https://api.deepseek.com` 时复用现有 `API_KEY`；其他模型/代理地址不自动复用其密钥，可选在 `.env` 配置 `DEEPSEEK_API_KEY` 并重启（显式配置优先）。页面只显示是否已配置，不显示密钥，也不保存到偏好文件或工具参数。未配置有效来源时启用请求返回400；不会实际验证密钥有效性直到调用上游。

工具介绍及提示词约束“仅在确需外部信息、核实最新事实、用户要求联网或读取链接时调用，本地知识和上下文足够就直接回答；摘要足够时无需fetch”。这是模型选择的软约束；关闭开关则由后端取消工具注册。网络文本作为外部数据，不作为行为指令。普通回答默认省略参考来源的偏好保持。资料库文件/软件下载链接仍优先使用 `get_file_link_from_library`，与公开网络检索用途不同。

每个接口共用进程级5次/秒滑动窗口，等待队列各32个，等待和请求共用60秒截止时间；跨会话、重建runtime仍共享限速，但无法协调其他进程/客户端对同一DeepSeek账户的使用。支持取消排队及HTTP请求，响应流最多1MiB，不跟随重定向、不自动重试。上游鉴权/余额/限流/不可提取正文等错误明确显示。请求/结果/耗时/次数沿用现有JSONL及“查看工具调用”；Search/Fetch的按次服务费用不冒充模型Token usage，正文作为后续模型输入时仍影响模型Token消耗。

直接Core调用可传 `webTools: { enabled: true, tools: ["search", "fetch"], apiKey?: "..." }`；同样默认关闭。无需新增软件依赖。运行全部验证用 `npm test`，只验证联网工具用 `npm run test:web-tools`。官方参数及支持范围见 [DeepSeek Search & Fetch](https://api-docs.deepseek.com/guides/search/)。

## 资料库文件 / 工具下载链接

默认工具 `get_file_link_from_library` 用于“给我 DT50S 规格书”“获取 UMS 工具下载链接”等请求。工具将当前轮的完整用户正文作为 `prompt`，POST 到 `https://tool-files.patrick-shenzhen.org/api/ai-search`；原样发送，不改写、翻译或拼入记忆/知识/历史/附件内容。实际正文由后端绑定当前 session 的用户消息，不依赖模型正确复述参数。

返回 API 的 JSON 检索结果（包含文件名、URL、匹配说明等），由 Agent 展示下载链接；未精确匹配时说明替代资料，不伪造链接，不自动下载文件或作为生成附件上传。此工具默认开启，可在 Web 的“Agent 设置 → 资料库链接”中独立开关，与六个二进制文件工具的独立开关互不影响。保存后统一作用于 Web、企微的新建及恢复 session 后续请求，重启仍保留。关闭时不注册该工具，也不注入对应调用提示词；其他检索/记忆工具保留，历史回答中的既有链接不会删除。设置沿用 `.data/web-agent-settings.json`，新增 `libraryLinks: { enabled: boolean }`；旧设置缺少此项时默认开启。直接使用 Core 的调用方可传入 `libraryLinksEnabled: false`。基础工具开启时6个、关闭时5个，六个文件工具另行累加。无需新增 `.env` 字段、密钥或依赖；请求超时60秒，支持停止取消，返回正文最多256KiB，重定向不跟随。

本机回归仍使用 `npm test`。升级按原流程同步代码、build/test 并重启 `product-expert.service`，无需单独修改 Bridge 配置。


## Text-only MCP

Set `MCP_ENABLED=true` and a dedicated `MCP_API_KEY` in `.env`, then restart `product-expert.service` to serve a Bearer-authenticated Streamable HTTP MCP at `/mcp`. Clients must send `Authorization: Bearer <your key>` on every request; missing, incorrect or unconfigured keys return HTTP401. No additional service is required. Tools: `ask_product_expert`, `get_task_result`, and `cancel_task`; fast answers return directly and longer requests return durable task handles. Only text is accepted, with no file or memory-write tools. Existing Web/WeCom authentication is unchanged.

MCP agent runs share the existing execution gate. Each task reports input/output/total tokens across its model/tool loop, with explicit missing-usage coverage. **Agent settings → MCP** shows submitted tasks and input/output/total tokens with an immediate, persistent access toggle. The saved toggle overrides the initial MCP_ENABLED value; disabling access preserves running work and totals. The previous /mcp-usage link redirects to Settings. `npm run test:mcp` runs isolated protocol and accounting tests; this update adds dependencies, so run `npm ci` when upgrading. Setup, tool contracts, retention and accounting boundaries: [MCP guide](docs/mcp.md).

## Synchronize 产品知识库维护

管理员侧栏新增 **Synchronize** → `/synchronize`。支持批量导入、完整转换、版本/slot 判断、候选索引修改和事务发布；报告反馈 **Re-Sync**；自然语言删除先预览再确认。只维护 `urovo-product-expert`，不改 SKILL/MEMORY 或 UMS。失败/疑问保留原件，成功后清理；普通问答不能检索 `newly_added`。

使用、状态、恢复、预算、安全边界、API 与 Ubuntu 新依赖见 [Synchronize 说明](docs/synchronize.md)。依赖检查 `npm run check:sync`，定向验证 `npm run test:sync`，完整回归 `npm test`。部署必须同步本次 systemd 只读挂载调整，保留你现有的 root/专用用户设置。正式启用后停止旧脚本/rsync 对知识库的覆盖同步。没有新增自动采集或定时 Sync。
