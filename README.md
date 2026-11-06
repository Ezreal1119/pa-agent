# Pi Patrick / CKD SOP

协作开发请先阅读 [开发与协作指南](CONTRIBUTING.md)。此分支包含后端、Web、桌面客户端及评分器；实际 Library、任务、密钥和安装包不随 Git 分发。

本分支相对 main 的 Core 改动、CKD 能力及后续累积记录见 [Core 变更记录](docs/core-changelog.md)。

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
- `src/integrations`: protocol and external-service adapters such as MCP.
- `src/memory`: long-term memory boundary.

The optional HTTP server and React UI live on the `web` branch.

## CKD V3 独立工作流

`create-ckd-sop` 从 `main` 的 `170fa45` 开始，实现 TypeScript 状态机和命令行入口。它使用 Pi 处理语义判断，使用项目内 CommonJS 脚本生成 Excel；不需要 patrick-agent 的源码、数据库或服务。提供 CLI、本地/Web 界面及 Electron 桌面客户端。

### 本地界面（推荐）

不需要编写 JSON，按表单填写即可：

```bash
cd ~/pi-patrick
npm run ckd:ui
```

打开终端显示的地址，默认 [http://127.0.0.1:4317](http://127.0.0.1:4317)。界面包含与你之前相同的 SOP 类型、模板语言、项目名称、文档编号、SOP 名称、作者；Factory Test 额外填写有序工序列表。点击“开始生成”后，流程来源和模型候选都通过按钮确认，只有手动工序或允许自由回答时才显示输入框。完成后可下载 Excel、图片检查 JSON 报告，并查看逐工序评分及独立图片构图评分。

左侧显示最近 30 个任务，可以继续原有 CLI 任务、恢复失败/中断任务或取消任务。关掉浏览器页面不会中止后台任务；重新打开后会恢复选中的任务。新建时所有填写仍以本次表单为准，可用“按此信息新建 SOP”复用历史输入。

`npm run ckd:ui -- --port 4318` 或 `CKD_UI_PORT` 可修改端口。服务仅监听本机地址；沿用 `CKD_LIBRARY`、`CKD_DATA_DIR` 及现有模型配置。没有新增前端框架依赖，也没有引入旧 Web UI。编译后可用 `node dist/ckd/ui.js` 启动。

### Library 语法检查

点击界面左侧“检查资料库”，再点“开始检查”，可以一次列出 JSON/JSONL 的语法错误、相对路径、行号和列号。默认检查全部类型和语言（含归档）；可选择 SOP 类型和语言，项目公共元数据仍会检查。校验只读，不创建任务、不调用模型、不自动修复。空字段或 `null` 在语法上可以合法；通过检查不代表业务字段完整。

启动本地界面服务后，也可通过 curl 或 Postman 调用：

```bash
curl -sS http://127.0.0.1:4317/api/library/validate \
  -H 'Content-Type: application/json' \
  -d '{}'

# 只检查 PCBA Test 英文资料
curl -sS http://127.0.0.1:4317/api/library/validate \
  -H 'Content-Type: application/json' \
  -d '{"sopType":"pcba_test","templateLanguage":"English"}'
```

`sopType` 和 `templateLanguage` 均可省略或设为 `all`，其他值与 SOP 输入相同。使用服务配置的 Library，不接受请求指定任意文件路径。成功扫描返回 HTTP 200，即使发现错误；通过 `valid` 判断结果：

```json
{
  "valid": false,
  "scope": { "sopType": "pcba_test", "templateLanguage": "English" },
  "scannedFiles": 2,
  "checkedEntries": 4,
  "invalidFiles": 1,
  "errorCount": 3,
  "errors": [{
    "file": "product_lib/GPOS710/pcba_test/processes/MCU_Download_Operation/tools_fixtures_equipment.jsonl",
    "line": 1,
    "column": 40,
    "code": "invalid_jsonl",
    "message": "Unexpected token '}', ..."
  }]
}
```

上面为截取第一条错误的示例，实际 `errors` 返回全部错误；行列从 1 开始。无法读取、无效 UTF-8 和符号链接也会列为错误，此时行列为 `null`。非法请求返回 400，Library 不存在返回 404。不读取图片、Excel 或普通文本文件。修复资料后重新检查；已冻结 Library 快照的任务如提示来源 Hash 变化，需要新建任务。

需要 Node.js **22.19.0 或更新版本**：

```bash
npm ci
npm run typecheck
npm run build
npm test
```

业务资源在 `resources/workflows/create-ckd-sop/`。本机 Library 已复制至 `.data/ckd/library/ckd-library-v2`，该目录不进入 Git。其他机器需要单独复制这份 Library，或显式指定自己的 `ckd-library-v2` 目录；不会自动回退到旧仓库。Library 保持只读，生成结果全部进入任务目录。

2026-10-08 已对本机 Library 做一次性中英文补全：新增 108 个工序的中文目录、47 个 SQ610 工序的英文目录，并补译 SQ68mini 英文目录内的中文内容。SOP 运行时仍只读对应语言资料，不自动翻译后续新增内容。随后按用户要求删除了 28 个 JSONL 文件内的 68 条全空占位行，包含原有 8 处语法错误；全量语法检查通过，英文 PCBA Catalog 可以构建。完整补全报告和备份在 `.data/ckd/translations/2026-10-08-bilingual/`，开发记录见 [中英文补全记录](dev-history/2026-10-08-ckd-bilingual-library.md) 和 [空记录清理](dev-history/2026-10-08-ckd-empty-rows.md)。

```bash
# 最小的 Factory Test 示例；唯一精确匹配不需要调用模型
npm run ckd -- start --input examples/ckd/factory-test.json

# 参考已有 SOP：TTY 下连续提问，也可以选择手动输入工序
npm run ckd -- start --input examples/ckd/reference.json

# 显式指定 Library 或任务存储目录
npm run ckd -- start --input examples/ckd/reference.json \
  --library /your/data/ckd-library-v2 --data-dir /your/app-data
```

`projectName`、`documentNumber`、`sopName`、`author` 为必填项。`sopType` 支持 `assemble`、`assembly_test`、`pcba_test`、`aging_test`、`factory_test`，默认 `assembly_test`。**Web 工作台和桌面端的表单目前只显示「Assembly · 装配」一项**（代码里由 `ENABLED_SOP_TYPES` 控制，恢复其他类型时把值加回该数组即可；服务端和旧任务仍支持全部类型）。`templateLanguage` 支持 `English` 和 `中文`，默认英文；中文选择独立的 `CN_process` 资料，不翻译英文内容。Factory Test 必须在输入 JSON 中给出有序 `factoryTestProcesses`，1–30 项。其他类型在运行中确认参考或手动来源；手动列表支持换行、分隔符、单项继续添加及重复项确认。

仅 `assemble` 可选填写 `revisionReason`（修订原因，最多 1000 字符）和 `revisionContent`（修订内容，最多 4000 字符，支持多行）；省略时留空。桌面端/Web 新建表单只在装配类型显示这两项，随任务持久化、恢复和“按此信息新建”保留，并写入中英文封面首条修订记录。首条制订者直接使用作者，不再依赖原版本是否填写；后续空白修订行仍按版本条件显示作者。长内容先调整首行可用高度，超出单页可读容量的全文保留在带引用的续页。生成器 CLI 对应 `--revision-reason` 和 `--revision-content`。新字段需更新后端，并使用桌面 0.1.7 或新版 Web；旧客户端不填新字段仍可使用新后端。

非交互模式遇到问题会保存状态并退出，用任务 ID 和问题 ID 回答后继续：

```bash
npm run --silent ckd -- start --input examples/ckd/reference.json --json --non-interactive
npm run --silent ckd -- get <task-id> --json
npm run --silent ckd -- answer <task-id> --question <question-id> \
  --text '参考 Library 中已有 SOP' --json --non-interactive
npm run ckd -- resume <task-id>
npm run ckd -- list
npm run ckd -- cancel <task-id>
```

TTY 可以用选项编号回答；`answer --text` 使用选项的完整原文。每个问题都有唯一 ID，重复或过期回答会被拒绝。`--json` 只输出 JSON 到 stdout；运行日志、错误和交互提示写入 stderr。使用 `npm run --silent` 去除 npm 自己的脚本标题。等待回答正常退出，失败或主动终止退出码为 1。

默认数据目录为项目的 `.data`；可用 `--data-dir` 或 `CKD_DATA_DIR` 设置。Library 可用 `--library` 或 `CKD_LIBRARY` 指定，参数指向 `ckd-library-v2` 本身。语义节点使用已有 `.env` 的 `API_KEY / BASE_URL / MODEL_ID`；完全确定性的路径不要求模型配置。编译后也可运行 `node dist/ckd/cli.js ...`。

每个任务保存在 `<data-dir>/ckd/runs/<task-id>/`：`state.json` 包含阶段结果、已回答及待回答问题、Pi 会话引用、错误和评分；`sessions/` 保存节点各自的 Pi JSONL；`scripts/` 保存输入、输出、日志和执行凭据；`outputs/` 保存最终 Excel 和 `image-quality.json`。`get --json` 的 `finalResult.output` 提供评分及摘要，`finalResult.artifacts` 是相对 `workspaceRoot` 的文件路径。

恢复只重放尚未提交的阶段。已经生成且有完整凭据的产物会检查 Hash 后复用；检测到产物修改或无凭据 Excel 时停止，不覆盖它。取消请求可跨进程传达；运行中的 `cancel` 可能先返回当前状态，随后通过 `get` 查看最终取消结果。取消和已完成任务不可续跑，失败任务可在解决原因后 `resume`。脚本或 Library 内容与任务的冻结快照不一致时，应创建新任务。

### TypeScript 业务接口

```ts
import { CkdWorkflow } from "pi-patrick/ckd";

const ckd = new CkdWorkflow({ libraryPath: "/data/ckd-library-v2" });
const run = await ckd.start({
  projectName: "GPOS710", documentNumber: "CKD-001",
  sopName: "Assembly Activate Device SOP", author: "Patrick Xu",
});
const current = ckd.get(run.id);
// await ckd.answer(run.id, current.pendingQuestion!.id, "参考 Library 中已有 SOP");
// await ckd.resume(run.id);
// await ckd.cancel(run.id);
const tasks = ckd.list();
```

现有 core 调用方式不变，`createSession(sessionManager?, options?)` 仍直接返回原生 Pi `AgentSession`。可选配置包括 `tools`（包含扩展工具名的精确白名单）、`extensions`、`cwd`、`systemPrompt`、`skillPaths`。CKD 通过独立 extension 仅注册 `clarify`、`submitStructuredResult`、`terminateStructuredRun`；不开放通用文件或 shell 工具。SDK 和模型不会直接执行业务脚本。

设计、恢复边界及迁移记录见 [CKD 设计](docs/ckd-design.md) 和 [开发记录](dev-history/2026-10-08-ckd-pi-migration.md)。SOP 生成读取现成 summary/overview；图片描述、AI 摘要维护和翻译补全现可通过下文独立 API 手动触发。当前已在 macOS 验证，Windows 实机与 Electron 打包留待后续。

## Library 翻译与摘要维护 API

运行 `npm run ckd:ui` 后，可从本机 curl/Postman 调用下面两个独立接口。它们不会在生成 SOP 时自动执行，也不接受请求中的 Library 路径；仅使用服务配置的 `CKD_LIBRARY`。

```bash
# 先预览翻译操作，不调用模型、不修改 Library。
curl -X POST http://127.0.0.1:4317/api/library/translate \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"GPOS710","sopType":"pcba_test","dryRun":true}'

# 补齐缺失语言，更新仍由系统管理且未经人工修改的译文。
curl -X POST http://127.0.0.1:4317/api/library/translate \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"GPOS710","sopType":"pcba_test"}'

# 翻译任务完成后，另行更新图片描述、summary.json 和 overview.json。
curl -X POST http://127.0.0.1:4317/api/library/summaries \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"GPOS710","sopType":"pcba_test"}'
```

创建成功返回 HTTP 202 和 `{ "job": { "id": "…", "status": "running", ... } }`；小任务可能在返回时已完成。两个接口均支持 `projectId / sopType / processId / dryRun`，省略筛选时处理全部现有中英文工序。`summaries` 另支持 `templateLanguage: "English" | "中文"` 和 `force: true`；force 重建摘要/概述，但仍复用相同 Hash 的图片描述。`translate` 不接受 force 或语言筛选，它按缺失方向双向处理。

```bash
curl http://127.0.0.1:4317/api/library/jobs
curl http://127.0.0.1:4317/api/library/jobs/JOB_ID
curl -X POST http://127.0.0.1:4317/api/library/jobs/JOB_ID/resume \
  -H 'Content-Type: application/json' -d '{}'
curl -X POST http://127.0.0.1:4317/api/library/jobs/JOB_ID/cancel \
  -H 'Content-Type: application/json' -d '{}'
```

状态为 `running / interrupted / completed / partial_failed / failed / cancelled`。`total / completed / counts` 表示进度，`items` 给出更新、复用、跳过、计划、冲突和错误明细，`warnings` 列出历史描述差异、已删除来源及失效摘要等问题。单项失败继续处理其他项；恢复失败或中断任务时重试失败/冲突项并跳过已完成项。已完成或取消的任务不再执行，重新维护应创建新任务。重启服务不会自动启动模型请求，需要显式 resume。

翻译保留工序 ID、原始表格字段、数量、数字顺序、技术标识、软件文件名、命令、路径及明确引用的 UI 标签。字面量先占位保护，返回后还原并校验，避免模型改写 UI 原文或命令。只翻译自然语言字段，图片原样复制；不重绘图片，不替换人工译文。已存在的空文件及空图片目录保留其覆盖语义。系统记录来源/目标 Hash：原文变化时，只有目标仍匹配上次自动输出才更新；人工修改产生冲突并保留文件。删除原文只报告，不删除译文。此前一次性翻译清单中源和目标 Hash 都能核对的原始资料会被接管；其他现有资料保持独立。翻译不写 summary/overview。

摘要维护沿用 V2 的五种类型、Assembly 特殊字段、`project → common → missing` 和照片整组覆盖规则；英文 Assembly 只用项目资料，中文 Assembly 保留已有公共回退规则。公共摘要保存在公共工序目录，项目有效摘要保存在 `derived / CN_derived`。两边分别读取本语言原始资料；只有逐文件翻译来源能证明等价时才复用并翻译另一语言的 overview，否则各自概述。空字段不会通过 AI 编造补全。旧摘要兼容迁入，不自动删除旧文件或失效目录。

新图片识别需要在 `.env` 配置以下三个字段，然后重启后端：

```dotenv
VISION_BASE_URL=https://your-provider/compatible-mode/v1
VISION_API_KEY=your-key
VISION_MODEL_ID=your-vision-model
```

视觉模型必须支持 OpenAI-compatible Chat Completions 的 `image_url`。没有视觉配置时，现有图片描述仍可复用，新图片的维护项明确报错；不会回退到纯文字模型。图片按内容 SHA-256 缓存，跨语言/路径/任务复用；必要时文字模型翻译描述，不再次识别同一图片。相同 Hash 的历史描述有差异时保留各自已有内容并报告。文字模型继续使用 `BASE_URL / API_KEY / MODEL_ID`。请求上限 5 分钟；临时网络错误、429、5xx 最多重试两次，校验失败不写入结果。当前 DeepSeek 维护请求关闭 thinking，通用 Agent Core 不变。

维护状态、备份及暂存文件在 `<data-dir>/ckd/library-jobs/<job-id>/`，逐次写入的 Hash/来源/备份映射在 `transactions/`；图片和翻译缓存及译文管理记录在 `<data-dir>/ckd/library-cache/`。这些目录和 Library 均不进入 Git。不同 data-dir 之间不共享缓存，但同一 Library 的执行锁仍共享。

维护与正在执行的 SOP 互斥，冲突返回 409；等待用户回答的 SOP 释放 Library 锁。维护后恢复旧 SOP 时，原有来源 Hash 校验可能要求新建任务。文件写入前检查来源和目标 Hash，先备份与暂存再逐文件原子替换。中断的多文件提交会阻止 SOP 继续使用 Library，直到对应维护任务恢复提交或回滚；请保留任务目录和 Library 旁的 pending 标记，不要手动删锁绕过恢复。

本机 curl/Postman 无需 Origin；浏览器写请求仍要求同源并带 `X-CKD-UI: 1`，不开放跨域。详细设计和验证见 [维护记录](dev-history/2026-10-08-ckd-library-maintenance.md)。

## 图片构图评分与测试 API

新生成的 SOP 在生成阶段检查实际采用的工序图片：普通类型按 p1–p12 排序，Assembly 包含 Operation_Photos 和前站检查图，Factory Test 只检查实际显示的第一张图片。模板 Logo 不参与。Excel 生成规则和工序业务评分保持独立；图片识别失败会记录到报告，仍交付 Excel。已完成的旧任务不追溯更新。

### 七项图片质量评分与 Web 设置

侧栏点击 **图片评分与设置**，可编辑七项权重（合计必须为 100）、四个条件上限和警告阈值，保存后用于新评估；上限留空即禁用。页面也可选择单张图片测试、触发/恢复/取消基准校准。生成结果中的图片条目可展开，查看各项得分、comment、校准 offset、条件上限、修改建议及最近两张参考图。

当前保守模式默认权重：清晰度 25、完整性 15、曝光 10、构图与留白 30、遮挡/反光/阴影 10、色彩 5、分辨率/压缩瑕疵 5。已有自定义 policy 保留。除构图外，模型输出档位和档位内 low/mid/high，当前采用两次判断中较低档的区间下限，按原区间归一化再乘配置权重。模型的mid/high保留供追溯，不直接抬分。构图只保留三项：空间利用40%、背景干扰40%、主体突出20%；调整构图总权重时按比例缩放。空间利用使用两次视觉观察中较高的无关留空估计，≤30%不扣，>30%且≤50%扣该项25%，>50%扣该项50%；超过70%时整图最终分数固定不超过60。背景干扰和主体突出沿用原判断。具体规则见 `src/ckd/image-assessment.ts` 和 `src/ckd/image-framing.ts`。

模型不直接给总分；它提取七项指标、主体框、有效内容/无关背景估计、置信度和中文 comment。连接设备的必要内部空隙不当作无关背景。主体框占比与有效内容估计分别输出；用于评分的有效内容占比不超过主体框面积，原始估计另行保留；这些是模型估计，并非像素分割测量。不保证对图片真实性或篡改作出鉴定。

计算顺序：初检与独立复核取较低判断 → 分项按区间下限加权求和 → 加非正平均偏差 offset（正offset记录但执行0） → 限制至 0–100 → 执行条件上限 → 四舍五入。默认关键内容不能可靠判断最高 59，主体可辨且明确的对焦/运动模糊影响必要细节、清晰度不高于明显模糊档时最高 69（普通反光不触发此上限），无关背景 >80% 或有效主体 <10% 最高 70；清晰度/分辨率未达最高档或主体突出存在中等及以上问题时默认最高80，同时触发取最低值。**最终分数 ≤80 警告**；90–100 优秀、81–89 合格、60–80 需修改、低于60不合格。总置信度、构图置信度或任一指标置信度 <0.7、无可靠主体时，返回待确认并提醒，不计入平均分。任一判断置信度低于0.85，或两次档位相差至少两档/构图相差至少8/30，也会提示复核，即使分数高于80。

配置保存在 `<data-dir>/ckd/image-quality/policy.json`，通过 GET/POST `/api/images/policy` 读取或保存。缺失文件使用默认配置；无效权重/范围/字段报错，不静默恢复默认值。

```json
{
  "alertThreshold": 80,
  "weights": {"clarity":25,"completeness":15,"exposure":10,"composition":30,"obstruction":10,"color":5,"artifacts":5},
  "caps": {"criticalUnreadable":59,"detailsBlurred":69,"excessiveWhitespace":70,"fineDetailUnverified":80}
}
```

### 图片测试 API

```bash
curl -X POST http://127.0.0.1:4317/api/images/quality \
  -H 'Content-Type: image/png' \
  --data-binary '@/absolute/path/image.png'
curl http://127.0.0.1:4317/api/images/policy
```

发送原始 PNG/JPEG 二进制，非 multipart/JSON。最多10 MiB、40MP、单边20000px。返回 `{result}`：总分、七项 components、baseScore、calibratedScore、grade、comment、扣分、建议、appliedCaps、nearestReferences、校准状态、完整策略快照/Hash和缓存信息。修改上限或阈值不重新调用模型；修改权重也复用分析，但之前的 offset 暂停应用，返回 weights_mismatch，需重新校准。

缓存位于 `<data-dir>/ckd/image-quality/seven-dimensions-v4/<SHA-256>.json`，仅保存观察，不保存可直接复用的最终分数；跨路径、任务和中英文复用。失败、取消、超时、无效JSON不写成功缓存。模型使用 VISION_* 配置，单次5分钟超时，临时网络/限流最多重试两次，无通用Agent工具。

每份 SOP 将设置和校准快照保存在任务 `outputs/image-quality-context.json`，中断恢复仍使用该快照；结果保存在 `outputs/image-quality.json` 和 `finalResult.output.imageQuality`，平均分按不同图片计算：有效分数与协议失败的 0 分兜底一起计入；其他错误和有效观察但置信度不足的未评分项不计入。警告/失败/待确认数量独立列出。上限针对单张图；平均分较高不能掩盖单张图片警告。

### 基准校准 API

参考图放在 `<data-dir>/ckd/image-calibration/samples/`，例如 `70-P1.png`、`80-P2.jpg`，分数0–100，可带小数。目录仅放普通 PNG/JPEG 文件。文件名、人类分数、其他参考图、offset和当前策略均不进入模型提示词。

```bash
curl -X POST http://127.0.0.1:4317/api/images/calibrate \
  -H 'Content-Type: application/json' -d '{}'
curl http://127.0.0.1:4317/api/images/calibration
curl http://127.0.0.1:4317/api/images/calibration/jobs/TASK_ID
curl -X POST http://127.0.0.1:4317/api/images/calibration/jobs/TASK_ID/resume \
  -H 'Content-Type: application/json' -d '{}'
curl -X POST http://127.0.0.1:4317/api/images/calibration/jobs/TASK_ID/cancel \
  -H 'Content-Type: application/json' -d '{}'
```

启动返回202和任务。按全部当前有效、去重样本计算 `offset = mean(人工分数 - 未校准七项总分)`，不拟合权重。新增Hash才识别，改名改分复用观察，删除样本移出拟合。同Hash同分数只算一次，不同分数冲突；逐项错误、资料变化、模型混用或权重变化时保留有效校准。人工标签高于当前条件上限会记录警告，最终评分仍执行上限。少于12个样本标记实验性；12个以上报告确定性留出误差，误差增加超过0.25不激活候选。最近参考按七项归一化指标距离排序，仅展示，不再改变总分。

新规则的 jobs、versions、active.json 位于 `<data-dir>/ckd/image-calibration/seven-dimensions/`；重启后显式恢复，不自动启动模型。旧 `subject-framing-v2` 缓存和旧留白校准保留，但不用于新评分；首次新规则分析会重新识别，旧报告留存。校准仅用于分析版本、实际模型及权重Hash匹配的观察，否则明确返回未校准状态。参数/样本/缓存/密钥继续排除Git。

API 只接受本机 curl/Postman；浏览器需同源和 `X-CKD-UI: 1`。基准缩略图 GET `/api/images/references/<SHA-256>` 仅返回当前校准记录里的普通文件，并验证路径和图片Hash，不接受任意磁盘路径。


### 图片评分历史 V2 与需求方复核

此前提取规则为 `seven-dimensions-v2`，数值规则为 `seven-numeric-v2`。这是可调整的试行策略，不强制图片落入某种分布。模型先根据具体区域的可见证据判档；能辨认物品不等于细节锐利，反光与曝光需要说明影响了哪些纹理、孔位或连接边界。轻微模糊不触发 69 分上限；关键内容确实因曝光或遮挡丢失时触发可配置的 59 分上限。仅有亮斑不直接判为最低档。

升级规则后旧分析缓存和校准保留，但旧 offset 不用于 V2。初次 V2 分析会重新请求视觉模型；之后阈值、上限调整从缓存重算。模型可能漏判轻微模糊或把暗部细节缺失解释成材质，comment 也是模型判断，不能当成像素测量或检测真值。

可生成不使用人工校准的样例复核报告：

```bash
npm run ckd:images:review
# 再次使用同一输出目录：成功观察复用缓存，失败图片重新请求。
npm run ckd:images:review -- --output .data/ckd/image-reviews/REVIEW_DIRECTORY
```

读取当前 `image-calibration/samples` 的带分数 PNG/JPEG，人工分数、文件名和 offset 不进入模型请求；默认警告线仍是当前策略（初始 ≤80）。输出 `review.html`（内嵌原图，可单独转交）、`review.csv`、`report.json` 和 Hash 清单。HTML 可填写需求方复评分及具体扣分原因，并下载 CSV 保存；不自动回写样本名称或激活校准。当前报告默认展开构图三项。逐项失败继续其他图片并报告，整体失败退出码为 1。只创建复核产物和观察缓存，不改正式 Library 或样本字节。


### 历史：需求方反馈修订 V3

该版提取规则 `seven-dimensions-v3`，数值规则 `seven-numeric-v4`。分别识别主要物品和辅助物品的框；程序计算主要物品的四边边距、最大中心偏移、边距不对称程度，辅助物品/手部不会替主要物品“居中”。主要物品可以是完整且有用的连通设备整体；必要内部空隙、均衡留边不直接按背景面积扣分。倾斜必须有适用的直边参照且影响展示，透视和背景干扰需要可见证据。冗余外框由所有有效框取并集，原模型外框保存在 `estimatedBoundingBox`，不丢失原始估计。不做像素分割，也不能保证辨认轻微变形。

模糊原因单独记录 `blurEvidence`，普通反光/阴影、压缩与对焦/运动模糊分开。改变提示词需要新观察版本；仅调整数学规则复用观察。旧校准不适用于新版本，已有报告不追溯更新。SOP 同时保存提取版本与数值版本，跨版本中断任务不能混用新规则，应新建任务。

可选操作说明：UI 单图测试增加操作说明输入，API 用 `POST /api/images/quality?context=<URL编码的操作说明>`（1–4000字符），图片仍是原始二进制。通用视觉观察按图片Hash缓存；随后**文字模型**只根据缓存中明确描述的可见部件匹配操作说明，按说明Hash独立缓存到 `image-quality/operation-focus-v1/`。不会重新读图，无法证明必要细节可见时返回 `needs_review`，不能当成对该细节的视觉检测。该结果独立显示，不改变通用图片总分；文字模型失败返回 `focusError`，保留质量分。生成SOP时读取有效工序步骤（Assembly 为 Operation_Instruction.txt），输出 `operationFocus`、`focusNeedsReviewCount` 并在页面展示。

最新人工复评分可导入用于后续手动校准：

```bash
npm run ckd:images:review -- --output .data/ckd/image-reviews/MY_REVIEW \
  --feedback '/absolute/path/需求方复核.csv' --import-labels
```

CSV需包含“图片”“需求方复评分”，可带“扣分原因”，必须覆盖当前全部参考图。报告保留文件名旧分和最新复评分，输出MAE、漏报、多报。导入记录在 Library 外 `image-calibration/seven-dimensions/reviewed-labels.json`，绑定图片Hash；同图改分后重新导入会更新。样本字节变化要求重新复核；用户显式改名改分优先于旧导入记录。此命令不激活offset，下次手动校准才使用新标签。人工分数、复核意见、文件名和offset均不进入模型请求。

本版仍为试行策略。19张样本的实际效果、剩余漏判及与V2的比较见 [V3反馈修订记录](dev-history/2026-10-09-image-assessment-v3-feedback.md)，不能将评分分布或本批拟合误差当成独立准确率。


### 保守复核 V4：宁低、多提醒

当前组合规则 `seven-dimensions-v4`、数值规则 `seven-numeric-v8`、独立复核提示词 `conservative-review-v2`。初检沿用V3观察协议和有效Hash观察，另发一次不带初检答案的视觉请求，专门核查细节清晰度、暗亮部细节、反光、取景和失真。复核必须返回填写后的JSON实例，不能返回格式定义。两次调用使用同一视觉模型，**并非两个独立模型，也不保证能纠正共同漏判**。没有提供人工分、样本名、反馈意见或offset。

六项档位取两次中较低者，程序按档位下限计分；构图取整组得分较低的观察，避免拼接不一致几何。默认满档证据使用区间下限相加约93.67，而非自动100；不是统一减固定分或虚构缺陷。明确不可判断仍不计分并提醒。任一置信度<0.85、非构图档位相差≥2、构图相差≥8/30，均额外提示复核；分数高于80也可能提醒。报告分别统计阈值警告、证据复核及总提醒，前两项可重叠。报告/页面保留两次原始观察及扣分依据。触发提醒时最终建议改为人工复核及有条件的整改建议，不再显示与提醒冲突的“无需重拍”；原模型建议仍保存在两次观察中。

拟合正offset继续记录，但运行时执行0，避免人工校准抬高保守判断；负offset仍有效。校准报告与留出误差按执行条件上限并取整后的实际分数计算，避免只展示限分前的误差；新增可调 `caps.fineDetailUnverified`（默认80，null禁用）：清晰度<最高档4、分辨率瑕疵<最高档3或主体突出严重度≥2时限制高分，同时提示复核。这是细节验收门槛，不等同于严重失焦诊断。旧policy未提供该项时补默认80；原有三个上限保持原值。上限/权重/阈值仍可在UI调整。默认没有激活本批新offset。

新图片首次最多两次视觉请求；已有V3有效初检只新增一次复核。初检存V3观察目录，复核存 `image-quality/conservative-review-v2/`，组合观察存V4目录，均以SHA-256缓存。阈值/权重/上限改变只重算。中断或复核失败保留已验证初检，下次只重试缺失复核，不把失败当成功。每次请求5分钟超时；复核输出上限8192 tokens，其他视觉调用默认4096不变。旧复核版本和旧完成报告保留，不混用旧offset。

新版未校准效果报告在 `.data/ckd/image-reviews/2026-10-09-v4-conservative/`。实际结果与验证见 [保守复核记录](dev-history/2026-10-09-image-assessment-v4-conservative.md)。旧V3报告仍显示历史100分，请以新报告为准；更多提醒不等于更高的整体准确率。

2026-10-12 修复：`collage/scene` 允许多幅有效教学视图各有主体，仍校验枚举、框坐标及最多八个物品；单视图保持唯一主体。拼接图不以一幅子图相对整图的偏心扣分；空间利用依据无关留空比例，偏心不再另设分项。提示词要求档位与证据一致；最终解释列出结构化档位、下限余量和具体上限原因，模型原文另保留，不按积极描述自动提分。

成功视觉缓存继续复用并按新数值规则重算；旧唯一主体约束导致的失败在下次评估时有一次有界恢复机会，其他格式失败仍保持独立0分兜底。旧校准offset不适用新数值规则，需手动重新校准，不自动调用模型或批量改写旧任务。已保存评分快照的中断任务按原版本保护拒绝混用，提示新建任务。

中文生成文件的前置页签为「封面」「生产安排表」，`assemble` 新模板使用客户的「排位图」；显式旧 Assembly 模板仍为「工站安排表」。公式引用同步处理且保留公式中的用户字符串；英文文件保留英文名称。仅 `assemble` 默认采用客户《SOP AI模版.xlsx》的中英文 1/2/4 格版式：每工序 1 张操作图用 1 格、2 张用 2 格、3/4 张用 4 格，按左上、右上、左下、右下顺序，上图下文，3 张时第四格留空；前站检查图不参与选格。`Operation_Instruction.txt` 优先按空行分段，无空行时按编号步骤（保留续行）或非空行顺序对应图片。不一致会提示：缺说明留空，多余说明独立保留；无操作图使用 1 格保留说明。意外多于 4 张的有效操作图按顺序续页保留，不截断。说明区可在保留至少 80% 原图片区高度的范围内增高，放不下的说明/检查文字在续页完整保留。

新 Assembly 模板物料默认七行、工具五行，优先在原表区域内按可读行高增加实际行数，并同步映射合并区、图片、检查区、作者和打印范围，保持原页总高度。超出容量的记录仍按顺序写入每页最多 20 条的物料/工具续表，报告列明原页行数及续表位置，封面、排位图与页脚计入续页。新模板来源文件原始字节保留；生成输出只含当前语言封面、排位图、工序及必要续页。其他四类 SOP、业务评分及图片评分不变；显式旧模板保持此前布局兼容。旧 Excel 不自动重生成，未完成任务仍按已有资产 Hash 校验拒绝混用版本。

### 管理员一键同步 Library

侧栏提供两个独立入口：**同步更新 Library**、**参考图片校准**。同步面板中的“开始同步更新”执行全部资料维护；“只检查与预览”不调用模型、不修改 Library 或同步基线。参考校准仍使用原有 samples 目录，单独触发；总同步不会运行它，也不会修改评分参数。参数继续在“图片评分与设置”保存。

上传或修改 Library 后，管理员点击一次“开始同步更新”即可按 Hash 增量同步、评分并刷新摘要；若任务未完成，可点击“恢复同步”。已有成功评分和译文复用缓存，失败图片会在下一次同步中重新分析；译文校验失败先有界重试，必要时只翻译文字片段并保留原有数字、型号和界面标签的顺序。若模型仍持续返回无效内容，任务会明确显示部分失败并保留原文件，不把失败结果当作成功。

```bash
# 全量范围扫描，按 Hash 增量处理，不接受外部路径或项目筛选。
curl -X POST http://127.0.0.1:4317/api/library/sync \
  -H 'Content-Type: application/json' -d '{}'
# 只预览
curl -X POST http://127.0.0.1:4317/api/library/sync \
  -H 'Content-Type: application/json' -d '{"dryRun":true}'
# 返回202 {job}；查询、恢复、取消复用维护任务接口。
curl http://127.0.0.1:4317/api/library/jobs/JOB_ID
curl -X POST http://127.0.0.1:4317/api/library/jobs/JOB_ID/resume \
  -H 'Content-Type: application/json' -d '{}'
curl -X POST http://127.0.0.1:4317/api/library/jobs/JOB_ID/cancel \
  -H 'Content-Type: application/json' -d '{}'
```

顺序固定为 **语法检查 → 双语同步 → 图片评分 → 图片描述/summary/overview**：

- 语法/读取错误阻止后续阶段，返回文件、行列号；修正后恢复会重新扫描。翻译有错误也不开始图片和摘要阶段。图片评分逐图失败后继续更新摘要，任务标记部分失败，不把失败算合格。
- 每文件保存双语 Hash 基线。只有一侧变化则由该侧同步另一侧；两侧同时变化且中文文件仍存在时，以中文为准覆盖英文，并在 warnings 中报告。首次无法证明修改历史的既有独立双语内容保留并建立基线，不凭时间戳猜测来源；已验证的自动译文记录可用于识别首次同步前的变化。
- TXT/metadata、JSON/JSONL（name/spec/specs/description自然语言字段）沿用数字、步骤、技术标识和行数保护；PNG/JPEG按字节复制。保留空文件/空目录、公共继承与项目覆盖。首次不把另一语言的照片合并进已有独立照片目录；后续显式变化按基线处理。
- 删除单独识别，避免把它当作缺失译文补回。仅删除能证明由被删除来源生成、且没有人工修改的对应文件；独立/人工修改内容保留并报告，保存缺失状态，后续未变化时不补回。移除整工序时清理可确认归属的空译文目录和未被外部修改的已登记失效摘要。非空/人工内容保留；所有删除也有备份、Hash与事务记录。
- Library中原始PNG/JPEG按Hash去重评分，中英文相同图片只识别一次；修改图片Hash会重新分析，删除图片从最新索引移除。参数/校准在任务开始时冻结，改阈值/上限只重算缓存，不重识别。目录照片仍沿用原业务的p1.png等命名规则；不符合规则的图片会评分，但摘要解析会报告未采用。
- 摘要复用现有维护器，按有效资料Hash增量更新；公共资料变化会使继承项目重建，明确的空值覆盖仍保留。图片描述和图片质量属于不同请求/缓存，跨语言分别按Hash复用。

任务仍在 `.data/ckd/library-jobs/<id>/`，同步基线和最新图片索引在 `.data/ckd/library-cache/<Library路径Hash>/{sync-baseline,image-index}.json`。两侧观察、评分参数快照、逐项错误、覆盖警告和删除清单保存在任务state。页面显示阶段进度、删除文件/目录数量、失败及需复核图片；刷新后可从历史恢复查看。模型调用不会因服务重启自动继续，需显式恢复；已提交文件及有效缓存继续复用。旧已完成SOP不追溯改写。

同步全程持有跨进程Library锁，与独立维护和SOP执行互斥，忙时返回409；等待回答的SOP不长期占锁，但恢复后继续校验来源Hash。同步期间请暂停外部编辑；每次替换/删除仍检查来源和目标Hash，变更时保留备份并报告。写入使用原有事务、逐文件暂存/原子替换及中断恢复；旧translate/summaries接口继续保留原有独立行为，不采用总同步的中文覆盖策略。

实现与验证见 [一键同步记录](dev-history/2026-10-09-library-overall-sync.md)。

## 全库图片评分预分析

生成 SOP 首次遇到新图时，需要初检和独立视觉复核，模型可能较慢。可提前批量分析所有原始 PNG/JPEG，中英文及重复路径按 SHA-256 合并，使用与 SOP 相同的观察缓存和评分规则；不改图片、译文、摘要或参考校准。

```bash
# 默认本项目 Library；默认 3 张并行，允许 1–4
npm run ckd:images:prewarm -- --concurrency 3
# 用启动输出的任务 ID 查看、恢复或取消
npm run ckd:images:prewarm -- --status JOB_ID
npm run ckd:images:prewarm -- --resume JOB_ID
npm run ckd:images:prewarm -- --cancel JOB_ID
```

支持 `--library PATH` 和 `--data-dir PATH`，默认沿用 CKD_LIBRARY / CKD_DATA_DIR。进度和逐图报告保存在 `.data/ckd/image-prewarm/<id>/`，stdout 输出任务 ID/结果，stderr 输出进度。Ctrl+C 保存为可恢复中断；显式取消为终态。恢复只重试失败或未完成的图片，成功缓存继续复用，来源 Hash 改变会报错。每请求超时和临时错误重试沿用现有视觉适配器，不把失败作为成功。

质量初检和独立复核均严格校验输出。无效 JSON/缺字段/多个 primary 时，分别最多补试2次，每次重看原图并反馈格式错误；不编补缺失数据，不向复核泄露初检结果。无效原始输出在 `.data/ckd/image-quality-errors/<分析版本>/<Hash>.json` 留诊断，不作为成功缓存。HTTP错误记录脱敏的提供方原因，普通400不盲目循环重试；修复后可显式恢复批次。

整个批次持有跨进程 Library 锁，与 SOP 执行和维护互斥；请在批次完成后再生成 SOP。参数/校准按任务快照计分，后续改参数可以复用观察重新计分。工序操作重点的文字匹配依赖具体 SOP 上下文，仍在生成时执行，不属于本次全库预分析。

## 用户桌面应用

独立 Electron 客户端位于 `desktop/`，展示登录、基本信息、进度/澄清、生成前图片确认和文件保存。现有 Web 继续作为管理员工作台，不受桌面登录影响。客户端不包含 Library、Agent Runtime 或模型密钥；本机开发版连接本机后端。

```bash
# 后端单独启动
npm run ckd:ui

# 另一个终端首次安装并运行客户端
npm run desktop:install
npm run desktop:start

# macOS Apple Silicon ZIP；Windows x64 NSIS 安装包
npm run desktop:pack:mac
npm run desktop:pack:win
```

0.1.9 起使用管理员在 Web 右上角“用户管理”创建的普通账号，停用旧测试账号 `111 / 222`。初始密码由系统随机生成、仅展示本次，首次登录必须在桌面端修改；之后可在账号区域点击“修改密码”。密码为 8–128 个字符（0.1.10 起），支持长密码、空格和粘贴，不自动填入或保存。令牌有效期 12 小时，仅保存在后端和 Electron 主进程内存；改密、重置、禁用、退出或后端重启后需要重新登录。任务按稳定用户 ID 隔离；旧测试账号和原管理员任务不分配给新用户，管理员仍可在 Web 查看。关闭窗口、退出或禁用账号不取消已运行的服务端任务。

桌面主界面（登录、任务、进度、图片确认）由后端 `/client/` 下发，页面文件在 `desktop/ui/`。改这些页面只需要更新服务器并刷新客户端，不用重新发包；断网或后端未启动时回退到 exe 内打包的旧页面。仍需要发新包的情况：Electron 升级、`main.cjs`/`preload.cjs`/`backend.cjs` 改动、内置域名变更。`/client/` 是公开静态页（不含令牌，登录走主进程 IPC），CSP 限制脚本/样式仅同源。

Web 仅供管理员登录。用户列表中的系统管理员来自 `.env`，不可删除、改密、禁用或修改角色；可新增普通用户、启用/禁用、重置随机临时密码，不提供永久删除或账号更名。普通用户记录与加盐 scrypt 哈希在 `<data-dir>/ckd/users/users.json` 原子保存，修改有写锁，不进入 Git；管理员凭据不复制到该文件。用户管理不会触发 Library 同步或生成任务。

管理员凭据继续只用于 Web；管理员本人需要使用桌面端时，也创建一个普通账号。普通账号为 3–64 位字母、数字、点、下划线或短横线，以字母/数字开头，大小写不影响唯一性；已禁用账号仍占用原名称。

输出包在 `desktop/release/`（Git 忽略）。历史本机包为 `CKD-SOP-0.1.0-mac-arm64.zip`，解压后启动 `CKD SOP.app`；当前云端 0.1.10 见下文。Mac 包未签名/公证。Windows 原生配置支持 x64 NSIS，本机 ARM Mac 提供完整 Windows x64 解压 ZIP，Windows 实机运行需另行验证。

本机客户端地址在 `desktop/config.json`，当前 `http://127.0.0.1:4317`，没有用户设置入口。独立云端版通过 `desktop/electron-builder.cloud.cjs` 将 `https://ckd-sop.patrick-shenzhen.cn` 写入打包元数据，主进程优先使用它；本机配置不改。Windows 上的 127.0.0.1 指 Windows 自己。云端版构建、分发及更新边界见 [桌面端发布说明](docs/desktop-releases.md)。

用户 API 为 `/api/client/login`、`logout`、`me`、`me/password`（POST，仅接受 currentPassword/newPassword）、`status`、`runs`、`runs/:id`、`runs/:id/answer|resume|cancel`、`runs/:id/images/:imageId`（GET 预览、POST 裁剪）、`runs/:id/generate`（POST 确认生成）和 `runs/:id/artifacts/:index`。登录提交普通账号 account/password；新版带 `X-CKD-Password-Change: 1`，结果增加 userId/mustChangePassword。需要改密的账号在旧客户端登录时返回 426 升级提示；新客户端的受限会话仅能查询本人、改密、退出。其余请求带 `Authorization: Bearer <token>`。管理员用户 API 在 `/admin/api/users`（GET 列表、POST 创建）及 `/admin/api/users/:id/status|reset-password`（POST），沿用管理员 Cookie 和来源校验。桌面创建任务继续带 `X-CKD-Image-Review: 1`；客户端由主进程发送请求，无浏览器 Origin，管理员原有 Host/Origin 检查不变。服务只监听本机，不开放 CORS。

### 账号与资料库（一人一库）

每个普通账号对应一个独立的 `ckd-library-v2`，和主库并排放在 `<data-dir>/ckd/library/product_lib_<账号>/ckd-library-v2`（目录后缀沿用账号原样大小写）：

- `product_lib` 是该账号私有的项目目录；普通用户登录后只能看到、修改自己库里的项目；
- `processes_lib` 是指向主库 `CKD_LIBRARY` 的目录联接（Windows 用 junction，其他平台用符号链接），公共工序资料、翻译、摘要和图片描述只维护一份；
- 主库就是系统管理员自己的库，部署前的存量项目全部留在主库。

管理员在「用户管理」里新增用户时同时建好该账号的库，用户列表的「资料库」列显示项目数并可「打开」进入该库的录入页，可以增删改任何人的项目。既有账号在首次登录/打开录入页时自动建库；想在部署后一次性建好，可在服务器运行 `npm run ckd:libraries:ensure`（先加 `-- --dry-run` 预览；`--data-dir`/`--library` 可覆盖默认路径，只建目录和联接，不动项目）。主库里已有的项目要分给员工时，用 `npm run ckd:projects:migrate`：`--list` 查看项目，`--project <项目> --to <账号>` 复制，或用 `--map mapping.json` 批量；先加 `--dry-run` 预览。默认复制、不动主库，旧任务仍按主库恢复；目标已存在会拒绝，`--overwrite` 先备份到 `<data-dir>/ckd/project-backups/`。工作台「导出 SOP」也有「资料库」下拉，选中后新任务落在对应的库。普通用户始终只能落在自己的库，传入其他 `library` 参数会被忽略。

任务会把实际使用的 `libraryPath` 记录在任务状态里，恢复、作答和下载都按任务自己记录的库执行，与当前登录是谁无关。禁用、重置或停用账号不会删除库和项目，需要清理时由运维手动归档。接口上：`GET /api/libraries`（管理员）列出所有库，录入接口用 `?library=<账号>` 选库，创建任务的 JSON 用顶层 `library` 字段选库（仅管理员生效）。

同一账号的库同一时间只允许一个出表任务（Library 排他锁），不同账号可以并行。翻译、摘要和整库同步只对主库执行；如果维护期间有人正在出表，源文件 Hash 校验会让该任务失败并要求重跑，不会写出混合版本。

### 逐工序录入的两级保存

录入页有两个保存动作：

- **保存当前工序**：把当前表单原样落成草稿（允许空工序名、图片与步骤数量不一致），左侧列表标「草稿」；草稿带 `draft.json` 标记，**不进入 catalog、不参与出表**；
- **保存到 Library**：先保存当前工序，再逐条校验该项目+语言下的全部草稿（工序名非空、图片与步骤数一致、图片 1/2/4 张），只把通过的工序转正并写入 `sops.json`；没通过的保留草稿，并在页面上列出是哪一道、缺什么。

资料库里只要还有草稿，创建生成任务会被拒绝，提示先在录入页「保存到 Library」。接口上：保存草稿用 `POST /api/editor/process` 并带 `draft: true`，发布用 `POST /api/editor/publish`（`{projectId, language}`）。

### BOM 导入

录入页侧栏「导入 BOM」支持 `.xlsx` / `.csv`（`.xls` 请先另存为 `.xlsx`，上限 20 MB、2 万行）。解析时在前 15 行里找表头并自动识别这些列名：

- 料号：**UROVO PN 优先**（客户 BOM 里还有 GERTECPN、Part Number 等厂商料号，不能混用），其次料号 / 物料编码 / 物料编号 / 物料号 / 编码 / Part No 等；表头写成「UROVO料号」「物料料号」这类中文组合也能识别，「厂商料号」会被排除；
- 名称：物料名称 / 名称 / 品名 / 物料描述 / 描述 / Material Name / Description / Name；
- 用量：优先「Usage for <项目>」这种单机用量列，并排除「Total Usage for ...」（那是整单总量）；也兼容用量 / 数量 / 单机用量 / Qty 等列名。

数字料号按单元格的显示文本读取（`3.01.01.10209`、`3010110209` 都按原样保存，不会变成科学计数法）。

导入后侧栏显示「已导入：文件名（N 行）」。BOM 按项目保存在 `product_lib/<项目>/assemble/bom.json`，原始文件保存为同目录的 `bom.import.xlsx|csv`；中英文共用，不参与出表。在物料清单里输入料号（失焦触发）后，会从 BOM 带出名称；BOM 用量为 1 时自动填数量 1，大于 1 或为空时留空，等人工填写。接口为 `GET/POST/DELETE /api/editor/bom`（POST 用 base64 传文件内容）。

### 逐工序录入：图片与步骤坑位

操作图片与步骤改为**固定坑位**：默认 4 个图片位 + 4 个文本位，同一序号的图片和文字绑定，但可以各自独立填写。

- 点击图片位选择文件，或直接把截图 `Ctrl+V` 粘贴进来（自动压到长边 1600px）；
- 「清空图片」只移除图片，步骤文字保留在该坑位，不会丢失；
- 拖动坑位可以整对（图片 + 文字）换位置；
- 已有工序如果超过 4 张图，按实际数量显示，不截断；
- 草稿允许某个坑位只有文字没有图片；「保存到 Library」时要求用到的坑位都是「图片 + 文字」成对、且图片数是 1 / 2 / 4 张，否则报「第 N 段只有文字、还没有配图」或「第 N 张图还没有写操作步骤」。

新版桌面端在资料准备后先运行原有图片评分，进入“等待图片确认”。此时尚未生成 Excel；每张参与 SOP 的图片可预览并按矩形裁剪，保留区域的四角和边缘可拖动，灰色区域被舍弃。可以直接点击“生成 SOP”，也可先裁剪；裁剪只写当前任务的临时副本，不修改 Library 图片，不触发重新评分或模型调用。完成页只展示 Excel 和原工序资料评分，图片评分在生成前确认页查看。关闭应用/后端重启后重新登录可继续等待中的任务；生成成功或取消时清理临时裁剪图，生成失败时保留供恢复。原图片分析缓存继续按 Hash 复用，裁剪不会写入全库评分缓存。详见 [图片确认与裁剪记录](dev-history/2026-10-14-image-review-crop.md)。

文件保存先通过同一受保护产物接口的 `HEAD` 读取文件名/大小，不再重复拉取整份任务评分；再通过原生对话框选择位置并以 `GET` 流式下载。新版客户端需先部署支持 HEAD 的后端，旧版 GET 下载保持兼容。界面显示已下载 MB/总量和百分比；普通请求最多60秒，下载连续60秒无数据或总计30分钟才中断，不再在持续传输满120秒时切断。超时、断流和本地保存错误分别提示；退出登录/关闭窗口会取消未完成的下载，后端生成任务不受影响。下载完成并校验后再替换目标；取消保存对话框不报错，失败清理临时文件。应用只允许打开本次应用会话中成功保存的文件。测试包含在 `npm test`，详细交付与验证见 [桌面端记录](dev-history/2026-10-09-ckd-desktop.md)。


### 图片分析格式失败：0 分兜底（2026-10-10）

初检/独立复核仍严格校验并最多补试两次。模型输出结构持续不合规或返回空内容/截断时，生成 SOP、管理员同步及单图测试使用 **0 分 + 强制警告**，保留原始错误并继续流程；0 分表示分析失败，不代表实际图片质量。不会填造七项指标或进行工序重点匹配。无效输入、来源变化、取消、超时、网络/配置错误仍按原错误处理，不套用此兜底。

失败记录独立保存在 `<data-dir>/ckd/image-quality-failures/seven-dimensions-v4/<SHA-256>.json`；同 Hash 后续复用，避免反复等待。已有有效成功缓存优先。该记录不是成功观察，不能用于参考图片校准。图片 Hash 变化后重新分析；评分公式、提示词、版本、阈值和已完成报告均不改变。新 SOP 图片平均分包含按 Hash 去重的失败 0 分，警告仍逐图片展示；工序业务评分保持独立。

`POST /api/images/quality` 正常分析返回原 `{result}`；上述协议失败返回 HTTP 200 `{result:null,fallback,error}`，其中 `fallback.score=0`、`reminder=true`、`analysisSucceeded=false`、`retryable=true`。HTTP 200 仅表示接口完成处理，不能当作识别成功。管理员同步任务保留逐项错误及部分失败状态，继续摘要阶段。Web 和桌面结果明确显示“分析失败，必须复核”。

显式重试失败记录（仍先复用已有成功观察，缺少的分析重新请求）：

```bash
curl -X POST 'http://127.0.0.1:4317/api/images/quality?retry=true' \
  -H 'Content-Type: image/png' --data-binary @/path/to/photo.png
```

也可显式恢复全库预分析失败批次；预分析和参考校准仍使用严格分析入口，失败不计为成功。重试成功后自动优先使用有效观察；历史失败诊断保留。不会自动重写旧任务报告。

### Ubuntu VPS 部署

服务器部署、Mac 绝对路径离线迁移、systemd、Nginx 和后续代码更新见 [VPS 部署与维护](docs/vps-deployment.md)。当前桌面云端基础地址为 `https://ckd-sop.patrick-shenzhen.cn`，管理员入口为 `/admin/`，使用独立的 `.env` 凭据及 12 小时内存会话；用户已自行通过 Certbot 配置证书。后端使用 `/opt/pi-patrick` 内的密钥和业务数据。0.1.9 用户管理需要先升级后端，再由管理员创建普通用户，最后分发新客户端；本机开发客户端地址保持原样。

云端 Mac ARM64 最新包：`desktop/release/cloud/CKD-SOP-Cloud-0.1.10-mac-arm64.zip`；Windows x64 解压版：`desktop/release/cloud/CKD-SOP-Cloud-0.1.10-win-x64.zip`。重新构建 Mac 包用 `npm run desktop:pack:mac:cloud`；Windows x64 机器上用 `npm run desktop:pack:win:cloud` 构建 NSIS 安装器，ARM Mac 可显式选择 `--win zip --x64`。首次安装依赖用 `npm run desktop:install`。用户管理必须先升级后端；桌面更新不会自动部署后端或更新已安装客户端，详见 [发布说明](docs/desktop-releases.md)。


### 固定像素评分 V1.23.0（2026-10-27）

CKD现在可通过 `CKD_IMAGE_SCORER=pixel-v1.23.0` 使用客户固定像素评分；未设置或设为 `legacy` 时保留旧视觉评分。独立Python解释器由 `CKD_SCORER_PYTHON` 指定，依赖固定为NumPy2.4.4、Pillow12.0.0。评分不调用模型；有操作说明时保留独立AI工序重点检查，仍需要VISION_*和文字模型配置。

V1.23.0权重为20/15/20/12/15/10/5，按97归一化；仅清晰度使用客户曲线，Cap为100/100/100/90。低于80不通过，80至95为警告，95起良好。Web只读展示参数，POST调参/拟合返回409。全局单评分并发，默认120秒超时，Linux子进程限2GiB；不缩图。单维失败以70分继续计算并显式复核，整个进程失败不伪造分数。

图片API路径不变；结果额外包含 `referenceResult`（客户原始输出）、`algorithmVersion`、`configHash`、`implementationHash`、`scoringStatus`、`dimensionErrors`。成功缓存独立位于 `ckd/image-quality/pixel-quality-v1.23.0`，旧缓存和校准不混入。旧任务按原快照恢复，历史报告不改。

验证：`python3 -B tests/pixel_v123_verify.py --handoff <交接包目录> --large-manifest <大图验收manifest.json>`；Node集成测试 `node --import tsx --test tests/ckd-image-pixel.test.ts`。客户图片置于Git忽略的.data验收目录。详见[开发记录](dev-history/2026-10-27-pixel-quality-v123.md)。

### 任务回收站与大图预览（0.1.5）

Web和桌面最近任务支持删除到回收站并恢复，运行中禁止删除。原任务/Excel保留，Library不变，不自动永久清理。图片使用受控预览，裁剪及Excel仍使用原始像素；桌面0.1.5提供旧失败预览的“重试预览”。同步前会列出无法读取的文本/图片原路径，需在源电脑解密或修复后重新上传；系统不自动解密。详见dev-history/2026-10-28-ckd-customer-feedback.md。

### Excel 已生成与检查进度

新版Web与桌面0.1.6会明确区分“Excel已生成”与“图片报告完成”，显示当前工序/文件和检查进度。原图片确认要求保留；普通自动生成任务可在AI检查期间提前下载Excel。提前文件不代表检查通过，最终评分报告和人工复核提示随后更新。旧客户端保持原交付方式。

新像素任务使用独立的 pixel-operation-focus-v2 工序检查：先复用图片描述，证据不足才针对工序检查原图，单张总预算60秒。像素评分公式及缓存不变。需要暂退检查优化时设置 CKD_PIXEL_FOCUS_MODE=legacy，只影响随后创建的任务；旧任务按保存快照恢复，不自动重跑生产整库同步。
