# 企业微信接入（VPS 原生部署）

Bridge 位于 `integrations/wecom-bridge/`，是独立的 Node.js 进程。通过企业微信智能机器人的长连接收发消息，通过本机 `http://127.0.0.1:4321/api/wecom/...` 调用现有 Product Agent。模型、产品技能/记忆、UMS 按需技能、五轮上下文、文件工具均复用后端。无需 Docker，无需企微账号密码，无需开放 4321 或公网消息回调端口。

需要在企业微信智能机器人配置页启用长连接、取得 Bot ID 与 Secret，并授权消息能力。SDK 的协议说明见 [企业微信官方 Node SDK](https://github.com/WecomTeam/aibot-node-sdk)。同一 Bot ID 只能由这一份 Bridge 负责，避免另外启动参考项目中的机器人。

## 同步代码与依赖

先在 Mac 提交并推送本次代码。VPS 按现有分支更新；下列操作按你已经选择的 **root 运行方式**。后续更新代码前，如果 Bridge 已安装运行，先单独执行 `systemctl stop wecom-bridge.service`；首次安装还没有这个服务时只需停止 Agent：

```bash
systemctl stop product-expert.service
cd /opt/ProductExpertCloud
git pull --ff-only
npm ci
npm run build
npm run test:wecom
```

`npm ci` 必须执行，本次新增精确版本 `@wecom/aibot-node-sdk@1.0.7`。不需要新增 Python 依赖；PDF/Word/PPT 等继续使用之前安装的文件处理环境。完整回归仍可运行 `npm test`。`test:wecom` 使用本地模拟模型和企微传输，同时真正执行文件工具，不会连接真实机器人。

## 配置 .env

保留已有模型、管理员和文件处理配置，在 VPS `.env` 追加以下字段；不要把真实密钥提交 Git：

```ini
WECOM_ENABLED=true
WECOM_BOT_ID=你的机器人ID
WECOM_BOT_SECRET=你的机器人Secret
WECOM_API_TOKEN=随机生成的本机API凭据
AGENT_MAX_CONCURRENT_RUNS=2
AGENT_RUN_QUEUE_LIMIT=8
WECOM_MAX_CONCURRENT_RUNS=2
WECOM_QUEUE_LIMIT=8
WECOM_RUN_TIMEOUT_MS=900000
```

`WECOM_API_TOKEN` 是本项目自己使用的凭据，并非企微 Secret，也不是模型 API Key。执行下面的命令生成一次，将输出填入 `.env`，至少 32 字符；Agent 与 Bridge 从同一个 `.env` 读取它：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
chmod 600 .env
```

`WECOM_AGENT_URL` 未设置时使用 `http://127.0.0.1:${WEB_PORT}`，默认 4321。只接受本机 HTTP 根地址；不需要 Web 登录 Cookie，也不受浏览器七天登录到期或服务重启影响。更换 WECOM_API_TOKEN 后需要分别重启 Agent 与 Bridge；只更换企微 Bot ID/Secret 时只需重启 Bridge。

到 Web 的 **Agent 设置**启用至少一个所需文件工具（各项独立开关）；已保存的 Web 设置优先于 `FILE_TOOLS_ENABLED`。图片识别及文档中的视觉分析仍需要已有 `VISION_LLM_*` 配置，扫描 PDF 能否识别也取决于视觉配置。Bridge 不绕过任何工具开关、文件权限和输出校验。

## 安装两个 systemd unit（首次接入必须做）

仅 `git pull` 不会更新 `/etc/systemd/system` 中的 unit。本次需要安装两个文件，并创建运行目录：

```bash
cd /opt/ProductExpertCloud
install -d -m 700 .data/wecom
install -m 644 deploy/product-expert.service /etc/systemd/system/product-expert.service
install -m 644 deploy/wecom-bridge.service /etc/systemd/system/wecom-bridge.service
systemctl daemon-reload
systemctl enable product-expert.service wecom-bridge.service
systemctl restart product-expert.service
systemctl restart wecom-bridge.service
systemctl status product-expert.service wecom-bridge.service --no-pager
```

现有 `product-expert.service.d/user.conf` 的 root 覆盖配置会保留；新 Bridge unit 按本次用户部署约定使用 root。若以后改用专用用户，两个服务及 `.data/wecom` 的目录归属必须一致。

两个服务独立管理，不配置 Requires/PartOf 或互相 Wants。Bridge 的 `After=product-expert.service` 只在两者同时启动时安排顺序，不会自动启动或停止 Agent。日常分别执行：

```bash
systemctl start product-expert.service
systemctl stop product-expert.service
systemctl restart product-expert.service

systemctl start wecom-bridge.service
systemctl stop wecom-bridge.service
systemctl restart wecom-bridge.service
```

停止 Bridge 后 Web/Agent 继续运行；停止 Agent 后 Bridge 仍可维持企微连接，但不能回答问题。Bridge 启动时会等待本机 API，后端未运行时会在日志报错并由其自身 systemd 重试。先启动 Agent 再启动 Bridge。若此前已经安装旧的 `product-expert-wecom.service`，先停止旧服务，安装更新后的主 unit 与新 `wecom-bridge.service`，移除旧 unit 后 daemon-reload，避免并行运行两份桥。

查看企微连接状态和收发错误：

```bash
journalctl -u wecom-bridge.service -n 100 --no-pager
journalctl -u wecom-bridge.service -f
```

看到 `WeCom authenticated: ...` 表示长连接认证成功；这不等于模型或文件处理已经验收。Bridge 异常会独立重启；主服务不因 Bridge 配置错误而停止。没有启用 `WECOM_ENABLED` 时 Bridge 正常退出，Web 可照常运行。

## 使用方式与并发

- 单聊：每个用户一个会话。
- 群聊：每个群共享一个会话，所有成员共享上下文，同一群的消息按顺序处理。
- 不同机器人独立命名空间；对话映射持久化，重启保留。
- 直接提问，或发送带图片的文字/引用文件提问。
- 单独上传文件时先回复“已收到”，不启动模型。随后 30 分钟内发送处理要求，会将待处理文件与问题绑定；群聊的待处理文件按上传者管理，其他成员的下一条普通问题不会自动消费它。进入 Agent 上下文后仍是群共享内容。
- 多份待处理文件可以指定文件名，或明确说“处理全部附件”。有歧义时不会擅自选择。
- 发送精确的 `/new` 或“新建对话”会重置映射，旧对话保留到原有清理期限；群里任何成员执行都会切换全群。
- 支持 PDF、DOCX、PPTX、XLSX、PNG/JPEG/WebP，以及TXT/MD/LOG/JAVA/JSON/CSV/HTML/XML/YAML/PY/JS/TS等UTF-8纯文本。纯文本复用read/grep，不调用文档转换或视觉模型。旧版 DOC/PPT/XLS、视频暂不支持；语音仅使用企微已经提供的转写文本。
- Excel 标书填写输出新 XLSX，原件不变。后端 `output` 事件及本轮结构化输出记录决定回传哪些文件，不解析模型回答中的路径、文件名或 fileId。多个已发布的产物都会发送。

HTTP Agent 全局默认最多 2 个运行，等待队列最多 8 个，**Web 和企微共用该上限**；同会话排队期间也不允许重复运行。Bridge 自己最多 2 个处理任务、另有最多 8 个等待位置；队列满会明确回复稍后重试。文件工具维持原有全局串行队列。HTTP 运行耗时记录从取得运行名额开始计算，排队时间不计入模型运行指标。

附件单文件上限为 `FILE_MAX_BYTES` 与 30 MiB 的较小值，单条消息最多 20 个、合计最多 60 MiB。Bridge 全局一次只下载一个附件批次，以有界流读取加密内容，再使用官方 SDK 解密；不同时保存多份大文件到内存。附件先暂存在 inbox，再顺序上传到现有会话文件目录。处理完成后删除暂存件。已绑定到会话的文件仍遵循原有会话手动删除和闲置三十天清理规则。

Bridge unit 另外限制 Node heap 为 192 MiB、整个 Bridge 为 300 MiB；这和主服务的 2600M 上限分开计算，并非预留内存。2 核/4 GiB VPS 的真实峰值和模型质量仍应在实际业务验收中观察，需要时把两个并发字段都改为 1。

## 重启与投递恢复

运行数据使用权限 600 的原子 JSON 文件，放在 Git 忽略的 `.data/wecom/`：

- `bridge-state.json`：会话映射、待处理附件引用、消息去重与待投递任务。
- `api-sessions.json`：后端登记的企微会话归属；企微凭据只能操作这些会话，不能读取 Web 专属会话、模型配置或修改 Agent 设置。
- `inbox/<jobId>/`：尚未交给后端的临时附件；传输故障恢复所需，完成后删除。
- `bridge.lock`：阻止同一数据目录启动多个 Bridge；异常退出的失效 PID 锁可自动恢复。

去重使用 `botId + msgid`，完成记录最多保留七天、最近一万条；活动任务不会因数量清理而丢失。消息正文在成功投递后从桥接状态移除，正式历史仍保存在现有 session JSONL。

排队任务可恢复；运行中断时先查询已有 run 记录及产物，不自动重新执行可能写记忆或填表的未知任务。结果发送失败会延迟重试，已经成功记录的文本片段和文件不会再次发送。平台确认成功到本地记录落盘之间仍存在崩溃窗口，因此不承诺消息投递严格 exactly-once。收到“运行中断，未自动重跑”时先查看 Web 记录，再决定是否重发。

企业微信回调回复失效时，会尝试通过主动消息接口投递结果；长回答按 UTF-8 字节分段，不按中文字符数截断。服务重启与长连接断开期间的消息能否由平台补发，取决于企微机制；没有承诺离线消息绝不丢失。

## 多机器人

可选用一个 JSON 数组替代单个 Bot ID/Secret：

```ini
WECOM_BOTS='[{"botId":"bot-1","secret":"secret-1"},{"botId":"bot-2","secret":"secret-2"}]'
```

每个机器人独立长连接与会话命名空间，共享 Agent 与上述全局并发上限。不要给同一个 Bot ID 开第二份 Bridge。

## 验收顺序

1. 单聊问一个简单产品问题，再换另一个用户问，确认上下文隔离。
2. 同一群两个成员先后追问，确认共享上下文；两个不同群确认独立。
3. 分别上传 PDF、DOCX、PPTX、XLSX，发送明确处理要求，确认对应工具执行。
4. 上传一份 Excel 标书，要求根据产品资料填写，下载返回文件，核对单元格、格式、公式和原件未改动。
5. 两个用户同时提问，观察响应和 VPS 内存；分别重启两个服务，确认旧对话可继续；单独停止 Bridge 时确认 Web 不受影响。

本机模拟传输和真实文件工具测试通过，不代表企微真实认证/群聊回调/主动消息权限、供应商模型回答质量或 VPS systemd 已经完成验收；需要配置真实机器人后按以上步骤确认。

## 企微联系人备注与消息通知

Web 左侧 **企微联系人** 显示机器人实际收到过消息的 User ID。私聊和群聊里的同一发送者共用一条备注（按 Bot ID + User ID 区分不同机器人），支持搜索、保存和留空清除。群消息登记的是成员 User ID，不把群 chatId 当作人。列表会从现有 bridge-state 中的单聊映射及仍保留的群消息记录导入身份；后续通过 Bridge 的独立事件队列登记，即使未启用通知也可维护备注。删除/新建对话不清除联系人或备注。

在 VPS 现有 `.env` 增加：

```ini
WECOM_NOTIFY_USER_ID=你的企微UserID
```

该值既是主动通知接收人，也用于排除该用户自己在私聊和群里的消息。留空关闭消息转发。多机器人可在 `WECOM_BOTS` 各项中指定 `notifyUserId` 覆盖全局值，显式空字符串可单独关闭；各机器人需有向对应用户主动发消息的权限。修改该配置后单独重启 Bridge；此次首次升级还新增后端联系人接口与 Web UI，因此先同步并构建代码，再分别重启两个服务。以后只修改备注不需要重启。

通知使用：

```text
🔔 Product Expert 收到一条新消息

对话人：赵芮同
类型：群聊
群聊：群的 chatId
时间：10/19 00:15

> 请按 i9200 资料填写这份标书。

附件：需求表.xlsx
```

“对话人”取发送者的最新备注，未备注显示 User ID；不再显示“会话”名称，不依赖 Web 对话重命名。时间固定为北京时间。通知只包含用户消息、附件名称/类型和身份，不含助手回答、推理、工具结果或文件内容。一般在收到消息后发送；附件最多等5秒取得文件名，未能及时取得时先显示类型，不等待 Agent 回答。群里仅转发机器人实际收到的回调，不能监听未发给机器人的消息。

所有当前新收到的消息都会尝试登记/通知，包括问答排队已满和不支持的消息类型；同一 Bot ID + msgid 去重，不回放启用前的历史通知。通知队列与 Agent 执行名额分开，发送慢/失败不阻塞用户问答，失败退避重试；长文本按18,000 UTF-8字节分段并保存成功进度，重启只补发未确认部分。尚未投递任何片段时，每次发送（包括重启后恢复已缓存的通知正文）都会按后台最新备注重建文案；有备注时“对话人”仅显示备注，不附User ID。已经推送的消息不会因之后改备注而自动回改，已确认部分分段保持原文以便继续投递。接收人配置变化时不会把旧待发内容转发给新的接收人。

数据位于 Git 忽略的 `.data/wecom/`：

- `contacts.json`：后端独占写入的身份及备注，原子保存、权限600，独立于session生命周期。
- `message-events.json`：Bridge 独占写入的身份登记/通知任务，最多500个未完成任务；完成后删除消息正文和分段内容，去重记录最多七天/一万条。失败任务最长保留30天，超过期限停止投递并移除正文。队列满或存储失败会记录 Bridge 日志，正常问答继续。

Web 管理接口 GET `/api/wecom-contacts`、PATCH `/api/wecom-contacts/:contactId` 需要现有管理员 Cookie 和修改请求令牌。Bridge 只可 POST `/api/wecom/contacts` 登记身份并获取当前备注，不能通过该接口修改备注；备注不进入 Agent 模型上下文。联系人文件故障不会自动重置已有备注，事件队列故障会停止本次进程的通知/登记模块并保留正常问答。平台确认后到本地落盘之间仍有崩溃窗口，不承诺严格 exactly-once。


## 联系人与用量统计

Web 左侧“企微联系人”打开独立的 `/wecom-contacts` 页面。可备注、搜索、刷新每个 Bot ID + User ID，并查看该人的提问次数、输入/输出/总 Token 和 usage 覆盖情况。群聊与私聊合并到发送者；群中共享上下文的消耗归本轮提问者。

- 一次实际开始的 Agent run 算一次提问，包含失败和停止；文件先上传等待指令、`/new`、队列拒绝不算。
- 包含工具循环的多次模型请求及文件工具结果已返回的专用视觉 usage；缓存命中不会重复加一次视觉调用，SDK 输入包含缓存 Token，输出已包含其报告的思考 Token。
- 升级前不回填。缺失/中断未返回的 usage 不估算；页面显示“未记录”或不完整比例。此统计用于调试，不能保证与供应商账单逐笔一致。
- 累计数据和去重游标保存在 `.data/wecom/contacts.json`，会话删除或30天过期仍保留。正常重启会继续累计；对话重新打开时按已持久化的 run 快照修复增量，重复恢复不重复计数。
- 需要 Agent 和 Bridge 都更新并分别重启。旧 Bridge 不传 `wecomSender` 仍能问答，但不产生新的联系人统计；没有新增 `.env` 设置。


纯文本附件详细白名单、编码要求见 [文件工具说明](file-tools.md#纯文本聊天附件)。部署这次改动需先构建，再同时重启主服务与Bridge；不改.env、不新增工具或Python依赖。


## 2026-10-21 消息提示调整

进入聊天不再主动发送欢迎消息。用户发消息后，初始等待提示统一为 **AI Thinking...**。Product Expert API 无法连接或返回 HTTP 502/503/504 时提示“服务正在升级中，请稍后尝试。”；Bridge 可在主服务暂未就绪时独立上线。已接受但结果未确认的 run 继续恢复，不自动重跑。此更新只需发布代码并重启 `wecom-bridge.service`，无需修改 `.env`。按本轮要求未执行验证。
