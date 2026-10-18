# 可选文件工具

实现位于 ProductExpertCloud。patrick-agent 只作为读取来源；未运行其构建、生成器或测试。六个模型工具共用独立执行队列、受控文件存储和视觉接口，不迁入源项目的 Agent Runtime、数据库或权限系统。

## 开关与兼容性

```ini
FILE_TOOLS_ENABLED=true
VISION_LLM_BASE_URL=https://your-provider/compatible-mode/v1
VISION_LLM_API_KEY=your-key
VISION_LLM_MODEL=your-vision-model
```

首次默认由 FILE_TOOLS_ENABLED 决定（false），修改环境变量后重启。Web 的“Agent 设置”可直接保存总开关和六个独立开关，后续请求立即生效；保存到 `.data/web-agent-settings.json` 后优先于环境变量的初始开关，重启保留，不改写 .env。默认关闭时：只注册原有 read/grep/find/ls/memory，不加载 file-skills，不启动文件任务或独立文件缓存清理定时器。会话过期删除其附件的联动仍然生效。已有附件、输出及历史工具记录保留，已登录管理员仍可下载历史附件。上传入口在关闭时隐藏，上传 API 返回 409。关闭并恢复旧 session 仍使用原五个工具。

六项全部启用时共 11 个工具，部分启用为原五项加所选项。独立开关同步限制 SDK 工具注册和直接执行，关闭的文件 Skill 不再自动提供；总开关关闭时保留各项选择，以便下次启用。默认产品 Skill、产品记忆与额外记忆注入（UMS 为按需普通 Skill，无专属记忆加载）、五轮窗口、SDK JSONL、会话重命名/删除和管理员登录沿用现有机制。新增文件 Skill 位于 resources/file-skills，按需读取，无需对应 MEMORY。所有文件 Skill 遵守默认不展示来源的回答规则。

启用会额外收窄四个原生读取工具的路径，只允许当前 session 文件、两个专家知识根目录及项目 Skill 资源。二进制文件必须使用专用工具，避免原生 read 在主进程直接解码图片。这是启用状态下有意增加的访问限制；关闭时恢复原读取行为。

## 六个工具

| 工具 | 主要参数 | 输出和边界 |
| --- | --- | --- |
| pdf_read | path、query、offset/maxCharacters、visualAnalysis、visualPages | Markdown/搜索、元数据及可选页面视觉描述；默认 off，最多四页，不提供全量视觉开关；未检测的扫描状态为 null |
| docx_read | path、query、offset/maxCharacters、visualAnalysis、imageIndexes | 标题、正文、表格、可选内嵌图片；不提供 Word 写入 |
| pptx_read | path、slideNumbers、query、offset/maxCharacters | 幻灯片、备注和支持的表格/图表文本；图片像素、精确布局和动画未分析 |
| excel_read | path、scope=workbook/worksheet、sheet、range、visualAnalysis | 工作簿/工作表、公式与缓存结果、批注、合并单元格；图片分析默认 false；too_large 时缩小范围 |
| excel_patch_template | sourcePath、outputPath、operations | setCell/setRange/clearCell/clearRange；新文件、内部验证、默认保护原文件和公式单元格，不提供 allowReplaceFormula 参数 |
| image_read | path、question、region | PNG/JPEG/WebP；视觉描述、原始/处理尺寸、缩放/裁剪信息；region 为原图像素坐标 |

路径使用附件列表返回的 inputs/... 或 outputs/...，也可使用允许的知识文件绝对路径。输出只接受新 .xlsx 文件名（可带 outputs/ 前缀），服务端生成实际存储 ID。禁止任意输出目录、覆盖和修改知识库、Skill 记忆。Excel 按指定 XML 部分修改，校验结构、原有内部部分摘要及意外变更后才发布；不计算公式，打开时请求重算。不得把缓存公式结果当作刚计算的结果。

ExcelJS 读取失败时按原逻辑回退到只读 OOXML，再回退到 MarkItDown。最后一级失去结构化单元格、范围、批注、公式及图片语义，会明确标注。Word/Excel 图片失败时保留可读文本并报告 unavailable。PDF 没有文字时可显式请求页面视觉分析。视觉结果存在识别误差，缩放后的概览不能保证小字完整；可对重要区域逐块读取。

## 资源与存储

```text
.data/files/<sessionId>/
  manifest.json       文件元数据、SHA256、原始名称
  inputs/             上传原件，只读
  outputs/            已验证的新文件，只读
  cache/              有配额的转换 Markdown 缓存
  work/<jobId>/       单次任务快照和临时结果
```

模型和浏览器不决定实际磁盘文件名，下载按 session + 文件 ID 查找。校验真实路径、符号链接、文件链接数及文件类型；输入快照避免工具改动原件。任务结束/失败/取消后清理工作目录；启动及每小时清理过期文件与一小时前的遗留临时目录。当前活动任务受保护。会话 JSONL 按最后活动保留三十天，过期删除前同步删除该会话整个文件目录；显式删除会话也同步删除原件、输出、缓存和临时文件。有效会话不会仅因附件目录时间较旧而丢失附件。附件删除失败时保留 JSONL 供后续重试，拒绝跟随目录符号链接。转换缓存最多 32MiB/session，同时受 session 总配额限制；24 小时过期，按内容/扩展名/转换器与 worker 配置隔离，forceRefresh=true 可跳过。原始图片/Base64 不写入对话日志；工具记录只保存文字、文件标识和统计。

默认限制是初始受控值，不代表所有达到上限的文件均能成功：

| 配置 | 默认 |
| --- | --- |
| FILE_MAX_BYTES | 10MiB/文件 |
| FILE_MAX_EXPANDED_BYTES | 64MiB/Office 包 |
| FILE_MAX_CELLS / FILE_MAX_SHEETS | 50000 / 20 |
| FILE_MAX_PAGES | PDF/PPTX 100 页 |
| FILE_MAX_PIXELS | 2000 万输入像素 |
| FILE_OUTPUT_CHARS | 60000 返回字符 |
| FILE_SESSION_QUOTA_BYTES | 100MiB，包含转换缓存 |
| FILE_TIMEOUT_MS | 120000，任务开始执行后计时 |
| FILE_QUEUE_LIMIT | 一个任务执行，最多八个等待，全进程共享 |
| VISION_TIMEOUT_MS / VISION_MAX_CALLS | 单次 60000 毫秒 / 每轮八次预算 |

Office ZIP 在解压前检查目录、声明尺寸、条目和路径，解压后检查实际尺寸、XML/实体和实际单元格、合并区域规模。最终仍有工作进程内存与时间限制。图片校验后，发给视觉模型的图像最多约四百万像素、最长边 2048；region 可保留局部小字。两种内存预算不同，缩小输出不等于解析只占用该部分内存。

视觉主机从 VISION_LLM_* 读取密钥，支持 OpenAI 兼容 Chat Completions。不会静默回退到未配置的文字模型。所有视觉请求通过主进程发起；文件执行进程不持有密钥。同轮相同图片/问题可复用文字识别结果，缓存有条数及空闲时间限制。工具详情记录排队、执行耗时、进程峰值 RSS、视觉次数、缓存命中和供应商返回的 token 用量；工具调用次数与视觉 HTTP 请求次数分别计算。

## 本机和 Ubuntu 24

本机开发：

```sh
npm ci
python3 -m venv .data/file-runtime
.data/file-runtime/bin/pip install -r requirements-files.txt
npm run build
```

设置 MARKITDOWN_COMMAND 为该虚拟环境中 markitdown 的绝对路径，再启用 FILE_TOOLS_ENABLED。Python 顶层依赖及约束版本分别见 requirements-files.txt / requirements-files.lock。MarkItDown 的 Magika/ONNX 依赖用于文件类型判断，无需本地视觉大模型或 GPU。

Ubuntu 24 生产部署建议使用隔离镜像：

```sh
docker build -f deploy/Dockerfile.files -t product-expert-files:ubuntu24 .
```

```ini
NODE_ENV=production
FILE_TOOLS_ENABLED=true
FILE_WORKER_IMAGE=product-expert-files:ubuntu24
```

应用在宿主机运行并需要可用的 Docker CLI/daemon。每个文件任务使用一次性容器：1 CPU、768MiB 内存、禁止 swap 扩容、64 进程上限、只读根文件系统、无网络、不授予额外能力，仅挂载该任务目录和 64MiB 临时空间。镜像不包含 .env/.data；容器不挂载知识库和 Docker socket，不传模型密钥。主进程通过受控标准输入输出转发视觉请求。Linux production 模式缺少 FILE_WORKER_IMAGE 时拒绝文件执行；本机开发子进程模式仅有 Node 堆和超时限制，不等同于 Linux 容器的 OS 内存限制。

2 核 2GB VPS 应为主服务和系统保留剩余资源，文件重任务保持单并发；构建镜像建议在开发机/CI 完成，再导入匹配 CPU 架构的镜像。Web 继续只监听 127.0.0.1，访问可使用 SSH 隧道，未改变既有 Host/Origin/登录策略。未在本次工作中公开部署 Web 或接入 WeCom。

## 附件 HTTP 接口

沿用管理员 Cookie、Host/Origin 和变更请求的 X-Local-Token：

- GET /api/sessions/:id/files：文件列表。
- POST /api/sessions/:id/files?name=原文件名：application/octet-stream 原始文件体，一次一个文件；运行/变更期间拒绝上传。
- GET /api/sessions/:id/files/:fileId：附件下载，检查 session 归属。
- POST /api/sessions/:id/run：接收 `{ "text": "分析这些文件", "attachmentIds": ["附件ID"], "effort": "low" }`。attachmentIds 可省略（等于空数组），最多 20 个且不可重复；检查当前会话归属及文件可读性。支持只发附件，text 为空字符串时使用默认分析提示。文件工具关闭后拒绝发送新附件。
- SSE 新增 message 事件表示用户消息已被接受，前端此时清空本轮待发送 ID；原 start/text/tool/context/done 事件保留。
- 消息视图中每条 user 消息增加 attachments 元数据，文件仍使用原下载接口。

上传到空会话时立即保存 session 头，支持未提问就重启后的附件恢复。上传不能绕过认证、令牌、文件类型、大小和目录边界。下载通过受控文件句柄流式返回。

## 消息与附件的关系

五种类型（图片、PDF、DOCX、XLSX、PPTX）采用同一流程：先上传原件，在输入框附近保留“待发送附件”，点击发送时文字和 attachmentIds 一起提交。每次发送只绑定明确选中的附件，下轮不重复携带。可移除待发送项；移除仅取消下一轮携带，不物理删除原件。待发送 ID 按会话保存在当前浏览器，刷新可恢复；跨浏览器不会自动继承草稿。已发送文件显示在对应用户消息下，原有会话文件和输出保留在折叠列表中。

关联以 message-attachments-v1 custom entry 保存到现有 JSONL，记录 run、轮次、消息时间、最终 SDK 消息 ID 和附件快照，不引入 SQLite，不把原始图片或二进制写入日志。用户原文不改写；仅组装模型请求时在对应 user 消息添加 Files attached to this message 文件清单。随五轮窗口整轮裁剪，历史消息恢复后仍可识别原附件。系统会话文件目录不再代表最新消息附件；新上传但未发送的文件不进入模型目录。原有旧文件保持兼容，不推测其历史消息归属。

## 输出文件交付

excel_patch_template 验证并发布新文件后，后端立即生成文件 ID，并以 generated-file-v1 custom entry 登记到现有会话 JSONL，关联当前 run、用户消息和工具调用。登记在工作目录清理和工具返回之前完成，不依赖模型回答中的文件名、路径或链接。

Web 通过新增 SSE output 事件及时收到 `{ runId, file }`，在本轮回答下显示“本轮生成文件”下载卡片，可展示多个文件。会话消息接口中 assistant 消息的 outputs 提供该轮文件元数据，outputNotice 区分仍在运行与本轮未完整完成。最终回复没有文字时提供结果占位；生成后模型报错或用户停止，不删除已成功发布的文件，卡片保留并说明本轮状态。

刷新/重启时恢复 JSONL 关联，下载沿用已认证的 sessionId/fileId 接口；服务端只展示本会话 manifest 中已登记的 outputs。旧工具结果中已有结构化 file 元数据时可恢复历史卡片；不会解析模型正文中的路径或猜测文件归属。会话文件折叠列表仍作为汇总入口，手动删除/三十天过期沿用完整目录清理。未成功发布的任务不创建下载卡片。

## 验证边界

本机自动测试、真实模型验证、Ubuntu 容器验证分别记录在 dev-history/2026-10-18-file-tools.md。小型夹具通过不能证明所有复杂业务文档均可完整转换，也不能代替真实 VPS 的长期负载验收。
