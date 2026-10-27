# Synchronize：产品知识库维护

入口：管理员登录后，左下角 **Synchronize**，独立页面 `/synchronize`，通过 **Incoming files / Sync reports / Delete knowledge** 三个 Tab 切换，每次只展示一个区域。开始 Sync、Re-Sync 和删除预览会自动切换到报告，Tab 和报告链接支持刷新恢复。维护范围只有 `.data/urovo-product-expert`，不修改 SKILL.md、任何 MEMORY.md 或 UMS。不增加普通聊天工具，不运行定时采集。

## 使用

1. **Incoming files** 批量上传，或把文件放到产品库的 `newly_added/` 后 Refresh。支持 PDF、DOCX、XLSX、PPTX、PNG/JPG/WebP、UTF-8 TXT/Markdown，每文件上限 **100 MiB**，独立于聊天附件的 30 MiB，不需要修改 `.env`。扫描和上传会忽略任意大小写的 `README.md`（包含子目录中的说明文件），不删除已有说明文件。同名资料上传自动生成不同名称。
2. 勾选输入，点击 **Start Sync**。一批最多 50 个文件，完整转换文本的批次内存预算默认 16 MiB（`SYNC_MAX_BATCH_MARKDOWN_BYTES`）；超过时保留转换结果，报告提示分批 Re-Sync，不截断发布。只有一个维护任务执行。提交时固定文件列表与哈希；后来的文件留到下一批。关闭浏览器不取消任务。
3. **Sync reports** 查看阶段、状态、已记录的文本/视觉 Token、版本依据、产品与 slot、逐文件差异、转换覆盖和清理结果。内容默认中文，控件英文。Token 是供应商实际返回的 usage，不是估算成本；缺失 usage 不补造。
4. 状态含义：**Needs your decision** 只表示 Agent 需要管理员回答业务问题（产品身份、版本先后、新产品授权、无法解释的冲突），报告写明具体问题；**Failed** 表示自动检查或处理失败、未发布，可直接 Re-Sync（说明可选）；**Awaiting confirmation** 用于删除预览、非同名 Hub 覆盖、补产品来源关联及关联来源的后续替换。Agent 的 `finish_sync` 会当场运行后端校验，一次返回全部问题，Agent 在同一会话内最多修正 3 轮，路径/索引类技术问题不再交给管理员。
   在报告中填写说明，点 **Re-Sync**。Re-Sync 原地重跑同一张报告卡片，旧尝试折叠为 “earlier attempts” 历史，不新开报告。原件未变化时复用转换；识别错误、遗漏等反馈或 **Reconvert original** 强制重新转换。仅明确的管理员反馈可以授权新产品、旧版本或同版覆盖；仍须通过路径、覆盖与索引校验。
   新产品身份和归属明确、仅缺少创建授权时，AI 会在该文件报告中生成 **AI-suggested instructions**。点击 **Use suggested instructions** 填入下方输入框，检查或修改后再点 **Re-Sync**。建议不会自动提交，也不构成授权；身份/slot 仍有歧义时只提示需要补充的信息。每次 Re-Sync 仅处理选中的这一份文件，重新核对当前知识库并维护相关索引；其他文件和旧报告保持独立。旧报告没有建议字段时仍按原流程手动填写。原知识库已有对应产品 Hub 时，即使资料全部位于 `_shared`、没有产品本地目录，也算现有产品；本次临时创建的 Hub 或指定其他型号的 Hub 不能代替新产品授权。后台缺少授权时会列出具体型号。
   Hub 文件名与产品目录名只差空格、标点或大小写（如 `K388 Pro` → `K388-Pro.md`）时，后端自动对应，无需确认。`oldPaths` 中误写的原件路径（如 `.pdf`）自动映射到同名 Markdown。`index.md` 仅在新建 Hub/shared 节点时强制更新。替换/删除时 `reviewedPaths` 只需覆盖直接引用该旧来源的页面，不要求复核仅通过 Hub/`index.md` 间接关联的无关产品页。
   若 Agent 选择另一个现有 Hub，报告会显示具体对应路径并进入 **Awaiting confirmation**。逐文件查看差异，点击 **Confirm publication** 才发布。不维护永久映射，不因反馈里写了“确认”就跳过该按钮。预览后资料库发生变化会拒绝发布，需 Re-Sync 重新生成；批次后续文件的成功发布也可能使早先预览过期。
5. **Delete knowledge** 用自然语言描述要删除的资料，点 **Preview**。检查具体来源文件及索引差异后点击 **Confirm deletion**。预览期间知识库变化会拒绝提交，需要重新预览。歧义请求进入人工反馈，不自动扩大范围。删除报告的补充输入通过 **Regenerate deletion preview** 重新生成预览，不显示 **Reconvert original**，也不会直接删除。

新增、更新都由专属 Pi 会话读取候选全文和当前知识后判断。模型只能生成候选方案，不能直接写正式库。可信新版本替换旧 Markdown，源文完整保存；Hub、依赖页面、共享回链、index 和 log 同步校验。同批输入可互相读取和比较；冲突或预算不足保留原件等待反馈。历史目录中的时间戳不是版本证据。

## 相同正文与产品覆盖

SHA256 相同只证明输入内容相同，不代表每个产品已有对应资料。报告的 **Verified existing source** 展示当前核验的 Markdown 路径与可从产品 Hub 到达该来源的型号。只有同名同内容、无反馈/重新转换、非 Re-Sync 且原有型号覆盖完整的普通重复输入保留快捷去重；不同名称、重新提交反馈或要求补型号时，先复核产品适用范围。

对已核验的相同正文，专用维护 Agent 可提出 `associate`：保留原型号，补上证据或管理员明确确认的新型号。后台只追加一个 Vault shared 来源节点、各产品 Hub 入口、index 和审计日志；不复制/移动/改写原正文，不改目录时间戳、文档版本或其他独立产品事实。节点同时列出所有产品回链。普通问答仍沿产品 Hub/shared 节点读取同一份原文，不需要另一个事实数据库。

新增关联必须逐文件预览并点击 **Confirm publication**。同一范围重复处理不再追加节点或日志；有反馈但模型判定“已经覆盖”的无变更结果仍展示确认预览，必须检查实际产品列表，不把“反馈已保存”当作型号已关联。适用性不明确时先回答业务问题；相同哈希本身不授权关联。新增产品目录、已占用的规格/彩页等单文档 slot 的版本替换，不能借此入口绕过正常流程；存在其他共享来源而无法安全确定 slot 时也转人工判断。

旧 **Duplicate** 卡片提供输入框和 **Review product coverage**，不显示 Reconvert original。旧报告无需迁移：后台从原有 Published 报告提取输入哈希、来源路径和发布正文哈希，再核对当前正文，因此原件已清理时通常无需重传。多份当前来源匹配时不会猜选，须在反馈中明确一条完整 Markdown 路径；已发布来源不存在或正文哈希已变则停止补关联，提示重新上传走普通 Incoming 流程。原件重新转换/内容修改仍使用单独上传流程。

**i9600 Mini 漏关联的操作：**

1. 更新代码、`npm run build` 并重启 `product-expert.service`，刷新页面。本次无新依赖，不需要改 `.env` 或 systemd。
2. 在 Sync reports 找到 `SQ69DM(A13GO)修改记录表.xlsx` 的旧 Duplicate 卡片，输入：

   > 这份修改记录同时适用于 i9600 和 i9600 Mini。保留 i9600 的现有关联，为 i9600 Mini 补充同一份修改记录的来源关联。复用已发布正文，不移动、不删除、不改写正文，不改变版本，也不改动两款产品独立的规格资料。

3. 点击 **Review product coverage**。若 AI 仍询问适用范围，明确回答“两个型号共用这份记录”，再生成预览。检查方案包含 `i9600`、`i9600 Mini`，修改 `product-knowledge-vault/products/i9600-Mini.md` 并补 shared 节点，原 i9600 来源正文没有删除/改写，再点 **Confirm publication**。
4. 确认 Published 后，检查 Mini 的产品 Hub 能到达同一份来源。Mini 的物理目录里不新增一份重复 Excel/Markdown 是预期行为；原件仍由既有成功清理规则处理。无需删除 SFTP 状态或强制重新拉取。

仅新建的受管关联节点触发后续保护：替换/删除共享正文必须列出所有已关联型号，复核直接依赖页，并重新预览确认；不能把 i9600 独有的新版本默默传播给 Mini。预览基线过期拒绝写入；事务失败回滚沿用原机制。普通未关联的新增、更新、删除和清理路径保留。

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

`read_knowledge` 找不到页面时返回 `KNOWLEDGE_NOT_FOUND`，包含具体路径、请求的原文/候选稿视图、两种视图是否存在及后续读取/查找参数。原文存在但尚无候选稿时指引先读原文；两者都不存在时通过搜索/列表及 `product_hubs` 查找准确路径，不自动猜路径、创建页面或跳过完整读取。缺失页的连续错误按工具、路径、视图和错误类型识别，不将不同页面混为同一错误；同一目标连续失败两次仍停止，改变offset不重置计数。请求总预算及其他错误/方案拒绝终止规则不变。

普通SYNC提交若缺少必读原文，先暂缓校验，后台直接返回首批原文；补读期间后续工具请求会继续推进读取，其他请求暂缓执行。范围仍仅输入正文、本次oldPaths/reviewedPaths/已有暂存页及关联模式必需来源/Hub；每批最多4段/40000字符，跳过已读段，候选稿不代替原文，不扩展到无关页面。返回requiredReads、剩余missingReads及reading/review_required阶段；读齐后必须经过新的模型请求重新审阅并显式提交，不自动接受旧方案，也不执行同批预先生成的后续写入/提交。补读改为方案校验前的读取阶段，不计为方案拒绝；真正校验失败仍按连续两次相同或累计三次终止，不重置之前失败计数。请求预算、发布检查和删除预览流程不变。

局部替换失败时，工具错误提供结构化诊断：目标路径、`replacementIndex`（从1起）、`matchCount`、当前 original/candidate 视图及哈希、可直接用于 `read_knowledge` 的 `nextRead`，以及最多8处字符 offset/行列/分段位置。区分片段不存在、多处匹配、哈希冲突和文件不存在；不回显完整正文或自动模糊替换。已暂存页面必须读 `candidate=true`。一批替换按顺序执行、全部成功后才暂存；第2项及以后的匹配位置可能对应前几项在临时文本中的变更，诊断明确标注，此时没有任何一项被保存，须按当前持久候选哈希修复整批。路径保护先于正文/哈希诊断，重复错误终止和正式发布确认不变。

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

### 视觉请求超时与续跑

SYNC 单次视觉请求的等待时间为 `max(VISION_TIMEOUT_MS, 180000)` 毫秒；聊天继续使用原来的 `VISION_TIMEOUT_MS`，不一起提高。仅本地单次视觉请求超时自动重试一次（包括响应正文读取超时）；停止操作、单文件整体截止、HTTP 错误、网络错误、识别不完整等不自动重试。重试重新获取模型并发名额，并计入原有视觉请求上限；不会延长 `SYNC_FILE_TIMEOUT_MS` 的单文件整体预算。

超时报告注明具体页码/区域、单次等待时间及尝试次数；整体预算到期显示 `SYNC file deadline exceeded`，主动停止显示取消。发生自动重试时 Conversion coverage 记录该区域的重试说明。仅收到供应商 usage 才累计 Token，未返回用量的失败请求不估算。

已完成区域的哈希缓存和转换版本（4）保持兼容。更新构建并重启原主服务后，超时失败的文件可直接留空反馈点击 **Re-Sync**，不勾 **Reconvert original**；原件和渲染图内容未变时，已成功区域复用，只继续未完成部分。无需新增依赖、修改 `.env` 或 systemd；本功能不涉及入库、索引或去重规则。

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


侧栏另有独立的 [Memory Injection](memory-injection.md) 对话框，AI 预览确认维护主MEMORY.md；同时提供管理员直接编辑主/Extra Memory 及各自下载，不属于资料Synchronize任务。直接保存校验格式/Revision 并备份，不调用模型，普通聊天工具权限不变。


## Manual source imports

**Source imports** is a separate fourth tab for SFTP ingestion. `Run now` reads `.data/sftp_sync_paths.jsonl` (path-only), downloads changed content into `newly_added`, and records per-file reports in `.data/logs/sftp_sync/`. It does not start knowledge Sync. **Incoming files**, **Sync reports**, and **Delete knowledge** keep their existing roles. Configuration, CLI usage and recovery: [SFTP imports](sftp-sync.md). No timer or WeCom notification is enabled.


## 待决问题的选择卡片

**Needs your decision** 报告优先显示简短问题，Agent 根据实际业务提供 2–8 个互斥单选卡片。默认不选；可 **Clear selection**，也可仅在 **Additional instructions** 中自行描述。选择不会触发请求或修改知识库，只有点击 **Re-Sync**（删除报告为 **Regenerate deletion preview**）才将该选项完整指令与补充文字一起作为本次反馈提交。可展开 **View selected instructions** 查看将提交的原始选项指令；组合反馈仍限制 16000 字符。选项和输入都为空时，有选项的待决条目不允许空提交。

详细判断依据和来源版本说明默认折叠到 **Decision details and evidence**；当前选项不放宽原有校验或删除确认。无法合理列出有限选项时，Agent 只提问并保留自由输入。旧报告若 reason 中有明确“选项 A：… / Option A: …”行，可直接显示对应原文卡片；没有明确行则保留输入框，之后 Re-Sync 可生成结构化问题和选项，不额外调用模型改写旧报告。选项只是一份待选择草案，不是管理员授权；新的 run 必须重新核对当前知识库。

本轮按要求不运行构建、测试、浏览器或真实模型验证。


## Library source imports (2026-10-21)

Source imports now contains independent **SFTP imports** and **Library imports** sections. Library imports selects only the latest complete upstream report's added/updated keys, classifies eligible document metadata using the shared text model and delivers verified PDF/PPTX/XLSX/DOCX files into Incoming. Run now / Stop and histories are separate; neither source importer starts knowledge Sync. Configuration, weekly Monday 06:00 Beijing timer templates, persistence and failure handling are described in [Library imports](library-import.md). Templates were generated only; this implementation round ran no build, tests, model/download requests or VPS operations.

## 报告读取与进度保存（2026-10-23）

页面两秒轮询只获取 `GET /api/sync/jobs/:id?view=summary`：保留状态、用量、问题、选项和差异路径/摘要修订号，不发送完整前后正文、WeCom 抓取元数据或覆盖检查正文。展开差异时才读取 `GET /api/sync/jobs/:id/items/:itemId/changes/:index?revision=:revision`；展开覆盖检查时读取对应 `/coverage`。关闭释放浏览器差异正文，进度轮询保留已展开的节点；内容修订变化后重新加载。详情拒绝过期 revision；权限仍为管理员 Cookie，写操作继续要求 Origin/CSRF，机器凭证无维护权限。启动/停止/Re-Sync 等请求可同样用 `?view=summary` 获取轻量返回。

不带查询参数的原报告 GET/POST 返回保持兼容，磁盘历史报告、计划和发布事务格式不迁移。摘要常驻内存只缓存路径/修订号；单个历史差异展开仍需解析原报告 JSON，详情读取在服务内串行进行。自动 Token 进度写入按一秒窗口合并，不为每条用量消息排队一份完整 JSON 字符串；序列化延迟到实际写入时。阶段、发布、错误、停止、退出的保存仍等待原子写入，并刷新最新计数。突然断电/强杀可能丢失最近一秒的用量显示，不影响已提交的发布事务恢复。

## 文本 Agent 的结束与失败报告（2026-10-23）

`finish_sync` 只有通过完整读取、来源、版本、依赖及发布计划校验才算成功；随后通过 SDK 正常结束当前 turn，不再付费请求结束语。同一响应中的工具按顺序执行，成功提交后不执行后续候选写入。业务 `review` 仍可正常结束并显示待确认；删除仍是预览，必须管理员确认才真正发布。

提交失败时，按问题集合判断连续重复：相同问题连续两次，或不同问题累计三次，即停止并保留实际校验错误；未读完整、参数格式错误也计入，不会把被拒绝的方案作为成功结果返回。其他工具连续两次完全相同错误也停止。预算用尽时直接显示预算原因，未发出的下一次请求不再将计数从64增加到65；旧报告的历史计数不改写。

SYNC 文本模型 HTTP/流错误、输出截断直接报告 SDK 提供的实际错误或 token 上限原因，不再被笼统的“未提交结构化决策”覆盖；该独立维护会话关闭 SDK 自动网络重试，避免错误后继续消耗。普通聊天、视觉转换重试、文件请求上限、WeCom退役条件和正式发布事务保持原有行为。此修复使合格方案正常结束、失败准确止损，不保证业务上不满足条件的退役也能通过；没有取消来源或完整迁移保护。无新依赖、env、systemd 修改。

## 删除预览的分批读取（2026-10-23）

删除 Agent 调用既有 `source_dependents` 时，把明确目标和直接引用页面登记到本次会话的只读清单。新增仅在删除模式提供的 `read_next_deletion_batch`，无需 offset，每次返回至多四个原文分段、合计 40000 字符，复用原有每段 20000 字符及哈希记录，自动接续并跳过已读分段；返回 `complete` 和所有剩余路径/offset。清单含删除请求正文，排除日志自动维护页及受保护路径，不沿 Hub/index 的间接引用扩散。

`finish_sync` 在删除模式一次返回所有未读原文的 `missingReads`；来源、直接引用页面以及声明 reviewedPaths/已有暂存修改页的缺失分段都会登记供继续读取。候选修改稿的读取不算作原文读取，补读完成后仍走原有验证和预览。文件正文及机器元数据不裁剪，不改变原始哈希或磁盘数据；不新增迁移预检、来源分类、API、依赖、环境配置或发布通道。清单登记不授权删除，三次提交/连续重复错误上限、最终确认、基线/哈希/迁移保护继续生效。模拟测试只能证明流程行为，不能保证真实模型的一次成功率或具体 Token 节省比例。

所有维护文本读取工具的 offset 使用字符位置，以20000为分段长度，列表/搜索分页仍沿用各自单位。非法分段或超出正文的非零 offset 会返回 `INVALID_READ_OFFSET`，附原请求、正文长度，以及同一视图第一段未读内容的 `nextRead.tool/args`；视图已完整读取则返回 complete=true、nextRead=null。非法请求不登记读取覆盖，不自动补读或把部分文本当作已读完。原文、候选稿与同批来源的修复参数分别保留各自身份；原有读取守卫、重复失败及请求预算不变。


## 公司级共享来源与已回答的问题（2026-10-24）

公司级资质不应被硬塞到某个产品：已验证WeCom分表在管理员明确允许后，可通过 `sourceScope=organization`、`products=[]`、`slot=others` 登记共享正文与受管索引，明确标注无产品适用性，不修改产品Hub。后续同分表更新保留该登记，无需每次再问。此例外不适用于普通上传/产品关联/其他分类，不能删除已有产品覆盖或绕过旧整本迁移保护。公司级来源的删除仍是独立预览并须确认，只能针对已登记的来源。

Re-Sync输入接口不变，用户本次选项/补充回答存为 `currentFeedback`，既有累积 `feedback` 和attempts保留审计。模型收到分开的current与history；当前回答覆盖同一问题的旧决定，其他未变约束仍应保留，不因历史意见不同再次询问。仅有新的实质业务歧义才提问；路径/校验问题按技术失败处理。空白重试沿用上次明确回答；旧报告按精确累积前缀恢复，不推断自然语言或自动选择发布。旧记录若最后收到的是“不发布”，应在此条目明确选择发布或输入新决定再Re-Sync，不勾Reconvert original即可复用未变的转换缓存。

现有产品来源、版本/完整读取、哈希、依赖检查、删除确认和事务保护保持。新公司级索引成员需要运行本次兼容代码；不自动迁移或编辑正式库与旧报告。

## DOCX字体与自动PDF转换（2026-10-25）

现有Sync会先检查DOCX，再在私有快照中用LibreOffice自动转PDF，复用PDF渲染与完整视觉识别流程，无需管理员为普通DOCX手工转换。字体预检仅排除可确认未使用的样式库条目，保留文档默认、默认样式、正文/页眉页脚/注释等部位及basedOn/link继承链。未解析的引用、重复定义或缺少段落默认时保守检查全部样式；仍检查活跃声明，不推断每个字种与格式覆盖的最终字体。报告记录排除数量或保守回退，不修改原DOCX、模板、正文和字体配置。

`Missing source font` 若来自实际使用或无法安全排除的声明，仍须安装对应源字体，或在能够正确显示文档的Word/WPS导出并核对PDF后上传；不能靠反复Re-Sync或自动替代字体来保证原排版。补齐字体后可对失败条目Re-Sync并选择Reconvert original。只提供Noto/Liberation等替代字体不等于源字体已安装；宏/嵌入/外链与PDF页数/覆盖/模型预算和发布检查不放宽，已有成功转换缓存保持兼容。

## PDF与DOCX跨页续表（2026-10-27）

直接上传的PDF，以及DOCX经现有LibreOffice链路转出的PDF，若在整页视觉识别中仅被报告“页尾句子/表格截断”，且有紧接的完整下一页，会增加一次双页复核。复核必须明确给出目标页末尾和下一页续文的原文；下一页仍独立识别，确认续文匹配后才记录目标页成功和缓存。真正缺失、模糊、混合问题、末页及无法确认续文仍保留原来的人工决策或失败处理；该局部补救不适用于切块区域、PPTX、XLSX或图片。此改动不改变DOCX排版、字体或图片渲染，不能修复实际渲染丢失。

普通通过页面的提示、请求数量及缓存保持不变。双页复核占用原视觉请求预算和整体截止时间，不新增复核超时重试，不使用之前被拒绝的识别结果兜底。技术失败条目在更新运行代码后可直接Re-Sync，不勾Reconvert original以复用已有完整页缓存；仍需完成其余页的识别和后续入库校验。已进入 **Needs your decision** 的DOCX保留原不完整检查点，更新后点对应的 **Retry this region** 才重新识别并触发可能的跨页复核，其他已完成页面可复用；普通Re-Sync不会自动清除待决定证据。也可用 **Reconvert original** 重做全部页面。部署只需构建并重启Agent，无新依赖或环境变量。

## Daily Auto-sync（2026-10-25）

**Sync reports → Settings** 可启用每天北京时间自动处理当前 Incoming files，默认关闭。复用现有 Sync 与报告，每批最多50份，超量按本次快照串行分批；新到文件留待下次。失败、待决等已出现在报告中的同名同哈希版本不自动重试，由管理员手动 Re-Sync/确认；新内容哈希仍可自动处理。已有任务或无文件时跳过，不排队、不补跑错过时间，不自动确认删除；停止当前自动批次会停止本次其余批次。

VPS后台运行，无需浏览器开着。复用导入的systemd设置helper，新增固定Auto-sync timer及owner-only本地触发，不另起模型/知识服务进程。安装、权限与限制见[Daily Auto-sync](auto-sync.md)；需要在VPS安装模板/更新helper，并在没有活动维护任务时重启主服务，再在Settings中选择时间并启用。


## 局部视觉缺失的人工决策（2026-10-26）

正常返回的视觉识别结果若仍有不可辨认内容，转换器会继续检查其他区域，保留可读文字和全部局部问题，报告进入 **Needs your decision**。不完整结果保存在独立区域检查点和私有 `partial.md`，不会写成成功转换缓存；接口失败、超时、截断、响应格式错误、文件/字体及资源限制仍按技术失败处理。

报告逐项列出页码/区域、问题说明。展开 **Inspect image and readable text** 才读取区域PNG与已识别文字，沿用管理员登录权限；图像不进入轮询摘要。可逐项选择 **Accept this specific omission** 或 **Supply the missing text**，不默认选中；补充必须填写内容。**Continue to publication preview** 提交本次明确决定，未选择的区域仍待决定。**Retry this region** 只清除该区域的不完整检查点并重新调用当前配置的视觉模型，复用其他已完成/待决定区域。本轮未增加自动裁剪放大或备用模型配置。

接受缺失或补充后，来源Markdown永久保留具体位置、问题和管理员决定，补充文字明确标注为管理员提供、未经OCR独立验证。任何含此类决定的非review方案必须停在发布预览，再点 **Confirm publication** 才提交；接受缺失本身不授权新产品、版本覆盖或其他业务例外。源路径、索引、版本、依赖、完整读取及发布事务仍执行现有检查。

决定通过结构化请求绑定原件SHA256、区域图像和本次问题/可读文字的指纹、报告修订号。旧页面、换版原件、区域改变或问题变化不自动复用确认；发布前再次检查原件身份。**Reconvert original** 清空本次视觉决定并重新识别全部区域。报告和attempt历史保留审计；轮询摘要不包含管理员补充全文。

部署需更新构建与前端资源并重启主服务，无新依赖、env或systemd配置。旧Failed报告可留空说明、保持 **Reconvert original** 未勾选，点 **Re-Sync**：复用原有成功区域，并在遇到新的局部识别问题后进入上述流程。已有成功转换版本4及其缓存保持兼容。
