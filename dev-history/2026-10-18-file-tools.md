# 2026-10-18 文件工具迁移与验证

实现、依赖安装和测试均在 `/Users/patrickxu/ProductExpertCloud`。`/Users/patrickxu/patrick-agent` 仅读取工具源码与依赖定义，没有运行其代码生成器、构建、迁移或测试。用户明确指定本次目标目录，以其澄清为准。

## 最终结构

- src/file-tools：配置、参数 schema、受控文件存储、单并发队列、隔离进程/容器、视觉桥接、预检查及源解析闭包。
- resources/file-skills：PDF/Word/PPT/Excel/图片的使用规则；在开关启用时提供，不增加业务 MEMORY。
- Web：上传/下载、当前附件上下文、输出列表、已有工具检查器显示统计；沿用原认证和 SDK JSONL。
- requirements-files.txt/lock、deploy/Dockerfile.files、docs/file-tools.md：可复现转换依赖及 Ubuntu 隔离部署说明。

默认关闭：read/grep/find/ls/memory 五个。启用共十一个。关闭并恢复曾使用文件工具的会话，实测工具集恢复五个，历史下载和调用记录保留。原每轮记忆快照、五轮上下文及业务只读边界未修改。启用时原生读取额外限制路径，以免绕过专用文件处理器。

## 本机模拟接口与真实格式

`npm test`：51/51，通过构建及 Core/Web/记忆/新文件模块套件。本次增加九项测试（每项包含多种断言），没有修改真实知识文件。夹具包含 PDF 文字、DOCX 正文/表格/内嵌图、PPTX 文本、XLSX 样式/批注/隐藏表/公式/合并区/图片及 PNG。

覆盖原件不变、公式保护、内部未更改部件摘要、ZIP 展开与大合并范围拒绝、超大 clearRange 拒绝、符号链接与跨 session 阻断、取消队列/视觉请求、缺少视觉时文本保留、同轮视觉缓存和转换缓存、认证与 CSRF、空会话上传后重启、删除附件、开关关闭后旧会话继续运行。既有 42 项业务/接口行为测试继续通过。

本机日志 `.data/debug/file-model-validation/final-tests.log`；密钥没有写入报告。

## 真实模型验证（不是模拟结果）

使用现有 .env 的主模型 DeepSeek Flash，通过真实 SDK AgentSession 处理隔离夹具。实际模型依次调用 pdf_read/docx_read/pptx_read/excel_read/image_read/excel_patch_template，六个均成功，无工具错误；Excel Data!B2 改为 77 并另存，原文件不变，未调用 memory。请求和结果在隔离 agent-data 下，不混入用户会话或知识库。

使用用户配置 VISION_LLM_* 的视觉接口单独验证 image_read，返回 TEST 42；该次约 2.3 秒、Node 峰值约 95MiB。另一次真实 Agent 也调用了该视觉接口。真实验证不构成复杂扫描件、识别精度或长期延迟保证。

结果：`.data/debug/file-model-validation/agent-result.json`、vision-result.json、agent-data/（全部忽略 Git）。

## Ubuntu 24.04 容器

构建 `product-expert-files:ubuntu24`，Ubuntu 24.04、Python 3.12、Node 24、Linux ARM64（Docker Desktop 本机）。镜像 d71143765c08。以项目实际 runner 的 1 CPU/768MiB、无网络、只读根、单任务挂载参数执行 `FILE_WORKER_IMAGE=product-expert-files:ubuntu24 node --test tests/file-tools.test.mjs`，五项套件通过，断言 backend=docker、cgroup memory.peak 有值且未超过上限。

六个小型夹具额外采样（视觉接口为本机模拟，容器内无网络）：

| 工具 | cgroup 峰值约 MiB | 执行约毫秒 |
| --- | ---: | ---: |
| pdf_read | 139 | 1084 |
| docx_read | 125 | 809 |
| pptx_read | 125 | 793 |
| excel_read | 61 | 443 |
| image_read | 32 | 241 |
| excel_patch_template | 62 | 331 |

原始数据 `.data/debug/file-model-validation/linux-metrics.json`，构建和测试日志同目录。峰值包括转换子进程和容器资源；Node RSS 单列只表示 Node 进程。小夹具不是最大文件/并发压力测试，未连接或部署用户实际 VPS，未做 x86_64 实机或 24 小时运行验收。2 核 2GB 采用单文件任务并发及有限队列，给主服务和系统留出内存；建议开发机/CI 构建对应 VPS 架构镜像后导入。

## 浏览器

隔离 4322 服务、一次性测试账号、本地模拟主模型，真实 SDK 和文件 worker。登录、上传 XLSX、运行 excel_read、展开调用卡、运行 excel_patch_template、下载 UI-result.xlsx。重新打开下载文件确认 B2=77。窄面板下压缩输入区域，消息及附件可访问。截图 `.data/debug/file-web-validation/ui.png`。

最终本机 4321 使用真实配置运行，开关开启。未改管理员或模型凭据；重启使旧登录 Cookie 失效，需重新登录。自动测试账号不用于用户实际服务。
