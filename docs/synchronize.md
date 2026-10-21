# Synchronize：产品知识库维护

入口：管理员登录后，左下角 **Synchronize**，独立页面 `/synchronize`，通过 **Incoming files / Sync reports / Delete knowledge** 三个 Tab 切换，每次只展示一个区域。开始 Sync、Re-Sync 和删除预览会自动切换到报告，Tab 和报告链接支持刷新恢复。维护范围只有 `.data/urovo-product-expert`，不修改 SKILL.md、任何 MEMORY.md 或 UMS。不增加普通聊天工具，不运行定时采集。

## 使用

1. **Incoming files** 批量上传，或把文件放到产品库的 `newly_added/` 后 Refresh。支持 PDF、DOCX、XLSX、PPTX、PNG/JPG/WebP、UTF-8 TXT/Markdown，每文件上限 **100 MiB**，独立于聊天附件的 30 MiB，不需要修改 `.env`。扫描和上传会忽略任意大小写的 `README.md`（包含子目录中的说明文件），不删除已有说明文件。同名资料上传自动生成不同名称。
2. 勾选输入，点击 **Start Sync**。一批最多 50 个文件，完整转换文本的批次内存预算默认 16 MiB（`SYNC_MAX_BATCH_MARKDOWN_BYTES`）；超过时保留转换结果，报告提示分批 Re-Sync，不截断发布。只有一个维护任务执行。提交时固定文件列表与哈希；后来的文件留到下一批。关闭浏览器不取消任务。
3. **Sync reports** 查看阶段、状态、已记录的文本/视觉 Token、版本依据、产品与 slot、逐文件差异、转换覆盖和清理结果。内容默认中文，控件英文。Token 是供应商实际返回的 usage，不是估算成本；缺失 usage 不补造。
4. 状态含义：**Needs your decision** 只表示 Agent 需要管理员回答业务问题（产品身份、版本先后、新产品授权、无法解释的冲突），报告写明具体问题；**Failed** 表示自动检查或处理失败、未发布，可直接 Re-Sync（说明可选）；**Awaiting confirmation** 只用于删除预览和非同名 Hub 覆盖。Agent 的 `finish_sync` 会当场运行后端校验，一次返回全部问题，Agent 在同一会话内最多修正 3 轮，路径/索引类技术问题不再交给管理员。
   在报告中填写说明，点 **Re-Sync**。Re-Sync 原地重跑同一张报告卡片，旧尝试折叠为 “earlier attempts” 历史，不新开报告。原件未变化时复用转换；识别错误、遗漏等反馈或 **Reconvert original** 强制重新转换。仅明确的管理员反馈可以授权新产品、旧版本或同版覆盖；仍须通过路径、覆盖与索引校验。
   新产品身份和归属明确、仅缺少创建授权时，AI 会在该文件报告中生成 **AI-suggested instructions**。点击 **Use suggested instructions** 填入下方输入框，检查或修改后再点 **Re-Sync**。建议不会自动提交，也不构成授权；身份/slot 仍有歧义时只提示需要补充的信息。每次 Re-Sync 仅处理选中的这一份文件，重新核对当前知识库并维护相关索引；其他文件和旧报告保持独立。旧报告没有建议字段时仍按原流程手动填写。
   Hub 文件名与产品目录名只差空格、标点或大小写（如 `K388 Pro` → `K388-Pro.md`）时，后端自动对应，无需确认。`oldPaths` 中误写的原件路径（如 `.pdf`）自动映射到同名 Markdown。`index.md` 仅在新建 Hub/shared 节点时强制更新。
   若 Agent 选择另一个现有 Hub，报告会显示具体对应路径并进入 **Awaiting confirmation**。逐文件查看差异，点击 **Confirm publication** 才发布。不维护永久映射，不因反馈里写了“确认”就跳过该按钮。预览后资料库发生变化会拒绝发布，需 Re-Sync 重新生成；批次后续文件的成功发布也可能使早先预览过期。
5. **Delete knowledge** 用自然语言描述要删除的资料，点 **Preview**。检查具体来源文件及索引差异后点击 **Confirm deletion**。预览期间知识库变化会拒绝提交，需要重新预览。歧义请求进入人工反馈，不自动扩大范围。删除报告的补充输入通过 **Regenerate deletion preview** 重新生成预览，不显示 **Reconvert original**，也不会直接删除。

新增、更新都由专属 Pi 会话读取候选全文和当前知识后判断。模型只能生成候选方案，不能直接写正式库。可信新版本替换旧 Markdown，源文完整保存；Hub、依赖页面、共享回链、index 和 log 同步校验。同批输入可互相读取和比较；冲突或预算不足保留原件等待反馈。历史目录中的时间戳不是版本证据。

## 存储与恢复

- 待处理原件：`urovo-product-expert/newly_added/`。成功发布或已发布的相同输入才清理；失败、取消和不明确的输入保留。
- 运行数据：`.data/knowledge-sync/jobs/*.json`、`events.jsonl`、`work/<attemptId>/`、`transactions/*.json`。重试成功会清理本次及前序尝试的临时原件、渲染图、转换副本。清理失败提供 **Retry cleanup**，不重复发布。
- 报告、管理员反馈和删除审计不随聊天的 30 天保留策略清除。历史完整差异按需从磁盘读取，常驻内存只留摘要和去重/审计信息。删除审计会给后续判断提供 legacy 依据；完全相同的已删除正文必须人工确认才能重引入，没有阻止下载的黑名单。
- 发布日志保存旧 Markdown；90 天后清理过期事务备份。报告中的修改差异仍保留。
- 发布前等待当前 Web/WeCom/MCP 问答结束，暂停新问答读取，核对完整知识库基线，落盘恢复日志后发布来源和索引。若失败则回滚；回滚失败会封锁后续知识访问，修复磁盘/权限并重启恢复后才能继续。进程重启先恢复未完成事务，再启动 HTTP；未提交任务标记 Interrupted。
- 只支持一个服务进程管理同一 `.data/`；不要同时启动第二个写入实例，也不要用 rsync 或旧 `product_docs_sync.py` 覆盖已由本功能维护的正式目录。外部改动会使候选方案失效，但外部工具不受进程内写锁管理。

## 转换范围与失败规则

维护转换独立于聊天工具的截断输出。TXT/MD 保留 UTF-8 原文；XLSX 提取所有有效工作表、单元格值、公式/缓存、备注和合并信息。DOCX/PPTX 通过 MarkItDown 提取并补充结构文本，LibreOffice 渲染页面。PDF 每页渲染；图片及页面按重叠区域逐个调用视觉模型，保存覆盖记录。不得把未识别的图表或图片当作空白跳过。

依赖缺失、显式源字体缺失、视觉配置缺失、重要区域不可识别、输出截断、页数不符、超出页/单元格/解包预算都会停止入库。带宏、ActiveX、非 XLSX 嵌入对象或外部加载内容的 Office 文件拒绝转换。按管理员要求，内嵌 XLSX 不读取：仅在私有转换副本移除包及关联引用，记录跳过清单，并在 Markdown 注明覆盖范围；不修改上传原件。不再因内嵌 XLSX 单独失败。其绑定的预览图标按 shapeId 精确排除，其他图片、图表仍须完整识别。旧 DOC/XLS/PPT、加密文件需提供支持格式的可读取副本。

当前保守限制：带视觉对象且存在隐藏工作表、隐藏行列或指定打印区域的 XLSX，无法证明渲染覆盖完整，会保留源文件并要求复核/提供完整导出版本，不盲目发布。显式字体检查不能代替视觉核对；样式复杂的文件仍可能需要安装原字体或提供可靠 PDF 导出。通过视觉检查代表模型报告可读，不等于人工逐字校对保证。

SYNC 的工作表上限单独固定为 **200**，不读取 `FILE_MAX_SHEETS`；聊天仍使用原设置（默认 20）。单元格/解包大小、页数、像素、超时和进程内存限制保留，超限报告显示实际数量、上限和相关对象。转换缓存版本升为 4，之前的转换首次 Re-Sync 会重新生成。

维护 Agent 可用 `patch_candidate` 提交带 SHA256 基线的精确局部替换；旧片段须唯一匹配，基线冲突拒绝。`log.md` 不再由模型整页重写：模型提交本次 `logEntry`（缺省用 summary/reason），后台保留完整历史后追加。日志是审计历史，不作为需要清除旧来源路径的活跃依赖页面。其他 Hub、目录、主题与依赖页校验不放宽。

状态区分 **Pending / Converting / Converted · waiting / Analyzing / Publishing**，先完成本批转换供版本比较，再逐份分析；Converted 表示等待分析，并非多个 Agent 正同时运行。

候选索引修改合计最多 8 MiB、最多 100 个变更文件；超过时要求缩小任务，不截断发布。

转换在固定命令的独立子进程进行，与聊天文件工具共用串行队列；转换阶段释放队列后逐区域调用视觉模型。文本与视觉请求共享现有模型并发额度。`.env.example` 提供每文件 30 分钟、64 次文本请求、128 次视觉请求预算；同批其他文件等待不计入该文件的活动预算。`FILE_TIMEOUT_MS` 另外限制单次原生转换阶段，默认 120 秒。任务耗时显示实际经过时间（含等待）。

## 本次界面/上传上限升级

本次不需要修改 `.env`，也不需要重新调整 systemd。更新代码、构建并重启原 product-expert 服务即可。

如果反向代理原来配置了 `client_max_body_size 30m`，要使用超过 30 MiB 的 Sync 上传，需要将其改为 `100m`，执行 `nginx -t` 后 reload Nginx。可在现有 server 中修改这一行，保留现有代理和证书配置；聊天 API 仍在后端单独限制为 30 MiB。100 MiB 是输入上传上限，解包、页数、转换和模型预算继续独立生效。

## Ubuntu 24 原生部署

不需要 Docker。除已有 Node/Python 转换环境，新增：

```sh
apt-get update
apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fontconfig fonts-noto-cjk fonts-liberation ripgrep
cd /opt/ProductExpertCloud
npm ci
npm run check:sync
npm run test:sync
```

`check:sync` 只检查依赖及配置是否存在，不输出密钥，不请求模型，不改知识库。`test:sync` 使用临时知识库、真实文件转换和模拟模型/视觉接口；MarkItDown 不在默认虚拟环境时可用 `FILE_TEST_MARKITDOWN` 指定。依赖缺失会明确跳过真实转换测试或使对应转换测试失败，不代表完整通过。

Sync 文本维护与聊天共用 `.env` 中的 `MODEL_ID`、`BASE_URL` 和 `API_KEY`，沿用全局思考强度及现有上下文/输出上限，不单独指定模型。视觉转换继续使用 `.env` 中已有的 `VISION_LLM_*` 配置。

`.env` 必须有原模型配置、`MARKITDOWN_COMMAND=/opt/ProductExpertCloud/.data/file-runtime/bin/markitdown` 和现有的 `VISION_LLM_BASE_URL`、`VISION_LLM_API_KEY`、`VISION_LLM_MODEL`。`SYNC_SOFFICE_COMMAND=soffice` 可保持默认。预算字段不写入时使用默认值。纯文本和无视觉对象的 Excel 可不调用视觉模型。

本次 unit 移除了整个产品知识目录的只读挂载，保留产品根 SKILL/SYNC_PROMPT、UMS 和 Python 运行环境的只读保护；主记忆由独立管理员Memory Injection入口维护，需要移除其单文件只读挂载；代码校验另外禁止修改任意层级的 SKILL/MEMORY。原有额外业务记忆工具的权限不变。

先检查 `systemctl cat product-expert.service`。使用仓库模板的非 root 部署可更新模板；**此前使用 root 运行并手工修改过 unit 的，须保留现有 User/Group 配置**，只同步 ReadOnlyPaths 与 TasksMax 的变化，不能直接覆盖账号设置：

- 移除 `ReadOnlyPaths=/opt/ProductExpertCloud/.data/urovo-product-expert`。
- 加入模板中的三个受保护文件 ReadOnlyPaths；保留 UMS/file-runtime 项。
- 将 `TasksMax` 调整为 192，为 LibreOffice 原生线程留空间；其他资源上限保留。

```sh
systemctl daemon-reload
systemctl restart product-expert.service
systemctl status product-expert.service --no-pager
```

已有 `product-expert.service` 同时管理 HTTP 与维护调度，不新增 service/timer。无需为此更新 WeCom Bridge 的服务文件。2GB VPS 上先用几份小文件验证；内存上限包含所有子进程，复杂大文档可能触发预算/服务内存保护，届时保留输入并缩小文档后重试。

## 视觉切图与失败重试

维护转换的图像区域最长边为1800像素，分块时保持至少120像素重叠，最后一块贴齐边缘；已经完整覆盖的方向不再继续切图。小于等于1800像素的页面/图片只发送整图，不会额外生成底部或右侧的细条区域。

视觉HTTP错误在报告中显示失败区域及经过脱敏、限长的接口错误原因，不显示API Key或图片Base64。失败时仍保留原件，不发布不完整资料。修复前因细条图片报400的条目，在更新代码并重启服务后可直接Re-Sync；转换缓存版本已更新，重新生成正确的区域，未变化且已成功识别的区域可复用。若需要全部重新识别，勾选Reconvert original。

此次修复无需新增依赖、修改.env或systemd配置，聊天image_read等文件工具的行为不变。

## 管理员 API

所有 `/api/sync/*` 要求管理员 Cookie；写请求需 `X-Local-Token`，保留现有 Host/Origin 检查。MCP key 与 WeCom token 不授予维护权限。

| 方法 | 路由 | 内容 |
|---|---|---|
| GET / POST | `/api/sync/incoming` | 列表 / 原始字节上传，`?name=...` |
| DELETE | `/api/sync/incoming?id=...` | 删除一个待同步文件；有任务运行时 409 |
| GET / POST | `/api/sync/jobs` | 历史 / `{ids: [...]}`，创建返回 202 |
| GET | `/api/sync/jobs/:id` | 状态和报告，页面每 2 秒查询 |
| POST | `/api/sync/jobs/:id/stop` | `{}`，协作取消 |
| POST | `/api/sync/jobs/:id/resync` | `{itemId, feedback, forceConvert?}`，返回 202 |
| POST | `/api/sync/jobs/:id/cleanup` | `{itemId}`，重试原件清理 |
| POST | `/api/sync/delete-preview` | `{prompt}`，创建预览任务返回 202 |
| POST | `/api/sync/jobs/:id/confirm` | 删除预览 `{}`；单文件发布确认 `{itemId}`，返回 202 |
| GET | `/api/sync/library` | 知识库递归文件列表 `{files, maxEditBytes}` |
| GET | `/api/sync/library/file?path=...` | 单文件元数据；`.md`/`.txt` ≤2 MiB 附 `text` 与 `hash` |
| PUT | `/api/sync/library/file` | `{path, text, expectedHash}`，哈希不符 409，Sync 运行中 409，只读文件 403 |

## Library

Library Tab 递归显示 `urovo-product-expert/`（跳过点路径与符号链接），Markdown 可预览或看源码。可编辑 `.md`/`.txt`（≤2 MiB，含 MEMORY.md）；`newly_added/`、`SKILL.md`、`SYNC.md`、`SYNC_PROMPT.md` 和其他格式只读。保存前显示 diff；服务端核对打开时哈希，在知识库写锁内原子写入，旧版备份到 `.data/maintenance-backups/library-edits/<时间>/`，并追加 `edits.jsonl`。手工编辑不会重新校验索引，改 Hub/index 时需自行保持链接一致。


侧栏另有独立的 [Memory Injection](memory-injection.md) 对话框，仅在管理员确认预览后维护主MEMORY.md，不属于资料Synchronize任务，也不改MEMORY_EXTRA.md。


## Manual source imports

**Source imports** is a separate fourth tab for SFTP ingestion. `Run now` reads `.data/sftp_sync_paths.jsonl` (path-only), downloads changed content into `newly_added`, and records per-file reports in `.data/logs/sftp_sync/`. It does not start knowledge Sync. **Incoming files**, **Sync reports**, and **Delete knowledge** keep their existing roles. Configuration, CLI usage and recovery: [SFTP imports](sftp-sync.md). No timer or WeCom notification is enabled.
