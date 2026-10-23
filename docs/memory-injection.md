# Memory Injection

管理员登录后，侧栏Synchronize上方的Memory Injection打开单个对话框。输入自然语言新增、更正或删除主记忆，可通过 **Attach file** 附上一份图片、文档或 UTF-8 文本，再点击 Generate preview；AI判断ADD/UPDATE/DELETE并整理正文。意图或匹配条目不明确时显示问题，修改输入后重新预览，不能确认含疑问的修改。英文控件，模型说明按输入语言生成。对话框底部的Download Memory File直接下载当前已保存的主MEMORY.md，不包含未确认预览或MEMORY_EXTRA，不调用模型、不改变文件。下载保留原始字节（包括BOM和换行），格式异常时也可下载备份；仍拒绝链接文件和超过2MiB的文件。

预览逐条展示操作、精确ID、理由及修改前后完整条目。AI 预览流程只有点击Confirm injection才更新`.data/memory/urovo-product-expert/MEMORY.md`。修改预览后的输入，或替换/移除附件，都会隐藏确认按钮，必须重新生成预览。普通聊天memory工具继续只写同目录MEMORY_EXTRA.md，WeCom/MCP凭证不能使用管理员接口。主记忆和额外记忆仍每轮分别注入；UMS无新记忆逻辑。

## 模型与保存

- 独立Pi会话共用.env的MODEL_ID/BASE_URL/API_KEY、上下文/输出上限及全局思考强度；只提供提交预览的内部工具；有附件时另提供限定该单一附件的 `read_memory_attachment`。没有任意路径读取、联网、Bash 或记忆写工具，不加载普通 Skill 或额外记忆。
- 一次最多30条操作、每条正文64000字符、输入16000字符。主记忆最多2MiB，超限报错，不截断。纯文本请求保持 3 分钟、最多 8 次模型请求；附带文件时 5 分钟、最多 24 次文本模型请求和 20 次附件读取，视觉调用继续沿用现有文件工具预算。使用现有全局模型并发额度和串行文件队列。
- 延续现有`# Skill Memories`、`## Memory mem_…`格式。新增ID和元数据由后台生成，邮箱unknown@email.com；更新保留ID、创建时间和作者，只更新内容/类型及更新时间；删除只移除指定条目；未涉及条目保留原文。正文标题提示从###起步。
- 预览30分钟有效，绑定整个文件的哈希，确认时重新读取；文件发生变化或预览过期，必须重新生成。确认只接受预览ID，不接受客户端传来的正文、路径或操作列表。
- 确认取得与问答/Synchronize共用的知识写锁，等待已开始的问答完成后校验、备份并原子替换，下一轮读取新记忆。拒绝路径符号链接/硬链接、坏格式及重复目标，不触碰SKILL/UMS/MEMORY_EXTRA。
- 预览和确认返回202，页面轮询状态。关闭对话框不取消任务，重新打开可继续；同浏览器刷新后用sessionStorage中保存的预览ID恢复。后台一时只执行一个主记忆操作。
- `.data/memory-injection/<id>.json`保留请求、模型用量、预览和确认记录；备份在`.data/maintenance-backups/main-memory/<id>.md`，不随聊天30天清理。预览不会写主记忆。重启后未完成预览标记失败；发布中断根据保存的前后哈希恢复状态，已经发布的确认重复调用不重复新增。

格式异常或缺失的主记忆不会被此入口擅自初始化；先恢复主记忆文件。服务重启/取消/模型失败保留当前文件；本机模拟接口的验证不代表真实模型判断准确率。

## 管理员API

沿用登录Cookie、Origin和X-Local-Token校验，机器凭证无维护权限：

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | `/api/memory-injection/download` | 管理员下载当前MEMORY.md，无路径/查询参数，attachment响应，禁止缓存 |
| POST | `/api/memory-injection/attachments?name=...` | 单个文件原始字节，最多30MiB；201返回附件ID及名称/大小/哈希 |
| DELETE | `/api/memory-injection/attachments/<id>` | 移除固定ID的临时附件；维护操作运行时拒绝 |
| POST | `/api/memory-injection/previews` | `{prompt, attachmentId?}`；仅一个可选附件ID；202返回预览ID |
| GET | `/api/memory-injection/previews/<id>` | 状态、问题、逐条前后对比及已记录用量 |
| POST | `/api/memory-injection/previews/<id>/confirm` | 空对象`{}`；202后轮询直至committed/conflict/failed |

## 已完成记忆目录迁移的VPS升级

不需要改.env、安装依赖、迁移记忆或增加service。提交/推送本地代码后，VPS按原流程停服务、拉代码、npm test（包含构建）。还必须打开实际unit：

```sh
systemctl edit --full product-expert.service
```

**删除这行**（若存在）：

```ini
ReadOnlyPaths=-/opt/ProductExpertCloud/.data/memory/urovo-product-expert/MEMORY.md
```

保留ReadWritePaths对.data的开放、当前root/专用账号以及SKILL/SYNC_PROMPT/UMS/file-runtime保护；不要把整个memory父目录设成只读。服务账号仍须能写主记忆所在目录，以便原子替换。

```sh
systemctl daemon-reload
systemctl start product-expert.service
systemctl status product-expert.service --no-pager
```

首次验证可用一条无关业务的测试记忆：Generate preview确认文件未变，再Confirm injection确认主记忆新增且额外记忆未变，最后预览并确认删除测试条目。实际Cloud记忆为准，不从Mac覆盖。


## 单附件输入

- **Attach file** 一次只选择一份，支持 **Replace file / Remove**。上限独立固定 30 MiB；文字要求仍必填。支持 PNG/JPG/WebP、PDF、DOCX、XLSX、PPTX 及现有 UTF-8 纯文本类型（TXT、MD、LOG、JAVA、JSON 等）；旧 DOC/XLS/PPT 和其他不支持格式拒绝。
- 点击 Generate preview 才上传选定文件并创建预览。附件通过现有聊天文件解析 worker 读取，不套用 Synchronize 全文/LibreOffice 转换要求；大文件按片段、工作表或范围读取，图片及必要视觉内容使用现有 `VISION_LLM_*`。沿用原解析能力与局限：例如 PPT 图片像素不会由 pptx_read 完整识别，关键证据不能读取时应要求澄清，不补造事实。
- AI 只整理文字要求中相关、适合长期保留的业务事实，不把整份附件复制到 MEMORY.md。附件内容、文件名及其内含指令均是证据，不是授权；有附件却未成功读取时不能提交记忆修改。普通聊天工具开关不控制此管理员专用读取入口，不向普通聊天增加能力。
- 文件在隔离的 `.data/memory-injection/files/memory-<uuid>/` 管理；客户端和模型都不传文件路径。公开预览绑定单附件ID/名称/大小/SHA256，正文修改和原有主记忆版本确认规则不变。文本与视觉已记录 Token 分开显示。
- 移除/替换已上传附件会删除对应临时存储；关闭对话框不取消后台预览，刷新后可恢复已生成预览及附件元信息。未使用的本地文件选择不跨刷新保存。临时附件目录在启动及下次上传时清理超过24小时的目录，最多64份、原件合计512MiB；报告不保存整份附件正文，既有主记忆预览/审计保留策略不变。
- 无新依赖、环境变量或 systemd 调整；已有图片识别配置可复用。按本轮要求未运行构建、测试、浏览器、真实文件或模型验证，尚未部署。


## 直接编辑与 Extra Memory 下载

Memory Injection 底部另外提供三个入口：

- **Edit Memory**：打开主记忆 `memory/urovo-product-expert/MEMORY.md` 的完整 Markdown。
- **Edit Extra Memory**：打开 `memory/urovo-product-expert/MEMORY_EXTRA.md`；缺失时显示空内容，可首次保存创建。
- **Download Extra Memory**：下载当前已保存的 `MEMORY_EXTRA.md`；不包含未保存草稿，也不包含主记忆。原 Download Memory File 保留。

直接编辑不调用 AI，也不需要生成预览。编辑器显示 Unsaved changes，只有点击 **Save changes** 才保存；关闭/按 Escape/Reload 时，有草稿需确认放弃。保存期间禁用编辑和关闭，保存失败或版本冲突保留草稿，可手动复制后 Reload 获取新版本再合并。迟到的读取不会覆盖重新打开的另一种记忆。CRLF 文件在编辑时保留 CRLF 换行。

保存内容上限 2 MiB，拒绝 NUL、无效 UTF-8、损坏或重复的记忆条目结构；必须沿用 `# Skill Memories` / `## Memory mem_…` / 元数据 / `### Content` 格式。正文标题层级仍只是格式偏好，不新增 `###` 强制验证。编辑已有事实时保留条目 ID 和元数据。主记忆不能清成空白，可保留头部表示空列表；Extra Memory 允许空白以清空全部条目。格式异常的有效 UTF-8 旧文件可先读取并修复；非法 UTF-8 无法进入编辑器，但下载保留原字节以便外部修复。链接文件拒绝读写。

主记忆保存使用现有维护互斥和知识写锁，等待当前回答释放读锁，保存前再次检查打开版本；AI Memory Injection 正在运行时直接保存返回冲突，避免互相覆盖。主记忆旧文备份到 `.data/maintenance-backups/main-memory/manual-<UUID>.md`；Extra 编辑与普通 `memory` 工具共用单进程队列、Revision 检查、临时文件原子替换及 `.data/maintenance-backups/extra-memory/` 备份。同原有工具，不提供跨进程 writer 锁，请勿启动多个写同一 Extra Memory 的进程。备份、记忆都保持 Git 忽略。

直接修改主记忆后，当前旧 AI 预览不能继续确认，需要重新 Generate preview；后端 Revision 校验也会拒绝其他页面持有的旧预览。Extra 修改不会让主记忆预览失效。保存后，已有会话的下一次 run 自动读取新内容，当前 run 仍用原快照，不需要重建 session。

新增管理员接口：

- `GET /api/memory-injection/files/main`、`GET /api/memory-injection/files/extra`：返回 `{text, revision}`。
- 对同一路径 `PUT`，仅接受 `{text, revision}`，保存成功返回新内容、Revision 和 changed；版本冲突返回 409。
- `GET /api/memory-injection/download-extra`：原始字节下载，文件名 `MEMORY_EXTRA.md`。

沿用管理员 Cookie、Origin、CSRF；Bridge/MCP 凭证无编辑或下载管理权限。不接收文件路径/查询参数，不提供其他文件读写能力。原 AI 预览、确认、附件接口保持。

部署只需原有代码更新、构建并重启主 Web 服务，再刷新页面；不新增 npm 依赖、环境变量或 systemd/helper 配置。前提与原 Memory Injection 相同：主记忆不能被旧单文件 ReadOnlyPaths 挂载保护。无需重启 Bridge 或重建聊天。
