# Core 累积变更记录

## 当前相对 main 基线的差异

基线：`170fa45c2bf00a00c3a9f904b6ebfc49b65754af`。

- PDF整页视觉检查仅在明确的页尾截断问题上增加一次相邻页复核，并以后一页独立识别中的续文核对后才登记成功；普通通过路径、旧成功缓存、其他格式和切块页保持原流程。见2026-10-25 PDF跨页续表记录。

- DOCX转换前字体检查仅排除可确认未使用的样式库条目，保留默认/继承/引用样式与正文、页眉页脚等实际部位的字体检查；引用不明确时保守回退完整样式检查。继续复用DOCX→PDF→识别链路，不替换缺失字体。见2026-10-25 DOCX字体预检记录。

- 新增独立 UROVO 行业研究与每日情报库：Web 手动十四天研究，场景/日期浏览，结构化证据、独立审核、五分钟检查点和二十分钟总预算，自动入库、补充/纠错版本、归档及 Markdown 导出；普通聊天、WeCom/MCP 处理链不变。背景、运行与证据在独立数据目录持久化；验证和部署说明见2026-10-25行业研究模块记录。

- Web管理员缺配置与WeCom导入Web测试补齐环境隔离，固定使用临时数据目录、文档清单和授权目录，避免继承VPS运行配置；仅修改测试，不调整应用或生产配置。见2026-10-24Web测试环境隔离记录。

- 修复公司级 WeCom 资料被强制要求产品归属：显式 organization scope 允许已验证 others 分表无产品发布并登记受管索引，禁止改产品 Hub/丢失已有产品关联；保留旧整本与原有发布校验。Re-Sync 本次回答与累积历史分离，空重试沿用上次明确回答，旧报告按精确前缀恢复；见2026-10-24公司级来源与当前回答记录。

- 前置本机试跑建立UROVO行业研究背景、周报流程和真实模型试刊记录，内部资料留在Git忽略的`.data/research/`；该试跑阶段仅复用原有Agent和联网工具，后续独立运行功能见2026-10-25记录。首轮与审阅修订的结果和局限见2026-10-24行业研究试跑记录。

- WeCom新增隐藏 `/welcome` 前缀命令：私聊/群聊可随时手动查看同一份欢迎语，不在欢迎菜单展示，不调用模型或修改会话、角色及附件状态；不替代平台进入事件验收。验证见2026-10-24隐藏欢迎命令记录。

- WeCom恢复私聊进入欢迎语，新增按机器人/私聊用户或群隔离的 `/role` 设置、取消/清除及 `/clear` 空白会话切换。后端角色独立持久化，按轮快照追加到System末尾、Extra MEMORY之后；命令持久化、范围版本和旧任务停止阻止迟到投递。保留后台归档、工具和角色设置，不影响普通Web/MCP，兼容旧新建命令。验证见2026-10-24 WeCom命令记录。

- 普通SYNC从可选补读升级为后台控制的原文读取阶段：缺漏提交先自动返回首批原文，后续工具请求推进补读且其他操作暂缓；读齐后须经新模型请求重新审阅并显式提交，同批旧写入/旧方案不执行、不自动获批。缺漏读取不算方案拒绝，真正校验失败仍受原上限且不重置计数；预算、来源/发布校验及删除流程保持。验证见2026-10-24普通SYNC补读与后台读取阶段记录。

- 修复 SYNC 读取缺失知识页的模糊反馈与重复错误误判：返回路径、请求视图、存在状态和精确后续工具；缺失目标按工具/路径/视图/错误类型区分，同一目标变换offset仍会在连续两次失败后停止。请求上限、保护路径和发布校验不变；验证见2026-10-24缺失页面读取记录。

- 修复共享来源产品误判为新产品：原库已有可唯一解析的产品 Hub 时，无需产品本地目录也视为现有产品；仍保留真正新产品的管理员授权，错误列出具体型号。只信任原始库，不信任本次暂存/另选 Hub。验证见2026-10-23共享来源产品识别记录。

- 修复 WeCom 非法分类与维护读取参数的误导反馈：元数据明确六种 allowedSlots，非法 slot 不再被提示为必须采用的路径；注册分类保持不可迁移。文本非法 offset 返回同视图第一未读段的精确工具参数，超范围请求不计覆盖。Node22.23.2构建、54项定向及368项全量检查通过，见2026-10-23分类/读取反馈记录。

- 修复 WeCom 首次 SYNC 的中文标题空值碰撞：标题比较保留 Unicode 字母/数字，并排除空键；无关中文共享页不再触发错误接管要求，真正同名仍要求显式 routing。运行仅调整 `wecom-sources.ts` 的标题比较，不改已有索引/映射/业务文件；Node22.23.2构建、38项相关与359项全量检查通过，见2026-10-23中文标题记录。

- SYNC 局部替换失败新增结构化反馈：区分零匹配、多匹配、基线冲突和缺失文件，附路径、替换项、当前视图/哈希及最多8处位置，指引读取正确候选稿并修复整批。失败整批不暂存，精确唯一匹配/哈希/发布确认不变；保护路径在正文诊断前拒绝。运行变更仅在 `knowledge-sync/agent.ts`；验证结果见 2026-10-23 替换反馈记录。

- 删除预览新增会话内只读分批清单：目标/直接引用页自动登记，每批至多4段/40000字符、自动续读；提交一次返回所有缺失原文 offset 并登记补读，候选稿不冒充原文。运行代码仅调整 `knowledge-sync/agent.ts`，不新增迁移预检或改变发布/确认/哈希机制。Node 22.23.2 构建、32项定向、346项全量以及最终 WeCom 退役补读模拟通过，见 2026-10-23 删除读取修复记录。

- Web 标签页统一使用管理员提供的 Patrick 图片作为 favicon，覆盖登录、工作区、Synchronize、联系人四页；固定 PNG/ICO 地址仅允许公开 GET/HEAD，图标缓存一天，其他认证和页面品牌不变。Node 22.23.2 构建、3 项既有 Web 回归及隔离 HTTP 核验通过，见 2026-10-23 favicon 记录。

- SYNC 文本 Agent 精确终止：不再用被拒绝方案兜底；有效 `finish_sync` 在当前 turn 正常结束，阻止同批后续写入和额外推理。预算/接口/截断/取消保留真实原因；相同提交问题连续两次或累计三次拒绝停止，完整读取/参数错误纳入；该维护会话关闭自动接口重试。运行代码仅改 `knowledge-sync/agent.ts`，不放宽 WeCom 退役、依赖、哈希和发布确认；Node 22.23.2构建、29项定向及343项全量检查通过，见2026-10-23 SYNC终止修复记录。

- Web 内存与重启登录优化：主 Node 堆 256→1024 MiB，提供仅修改 ExecStart 的既有 VPS drop-in；SYNC 摘要轮询、差异/覆盖展开读取、用量进度按秒合并且写入时再序列化，保留原报告/发布恢复格式和完整接口。登录摘要签名落盘，重启保留七天内 Cookie，退出/到期/改凭据继续失效；Origin/CSRF 不放宽。Node 22.23.2 构建、328 项全量检查及隔离浏览器重启/展开验证通过；合成 26.9 MB 报告四路读取的峰值 RSS 1369→190 MiB，非真实模型/VPS测量。见 2026-10-23 内存优化记录。

- Memory Injection 新增 Edit Memory / Edit Extra Memory / Download Extra Memory，保留原主记忆下载。管理员直接编辑完整 Markdown，不调用 AI；格式/2MiB/Revision 校验、备份原子写入、草稿与冲突保护，Extra 与原 memory 工具共用单进程写队列；主记忆编辑使旧预览失效，下一 run 生效。新增固定文件管理员接口，无新依赖/env/systemd 修改；Node 22.23.2 构建、319 项全量和最终 19 项定向检查及隔离浏览器操作通过，见 2026-10-23 直接编辑记录。

- WeCom 分表进入 SYNC 时核验现有导入回执/快照，以 docid + 工作表 ID 绑定自身共享来源；后台在原发布事务中维护总入口，保留独立产品 accessories 和旧整本迁移兜底，禁止误替换其他分表/整本。Guide 首次分表 SYNC 前需显式本地 routing 接管旧总入口；旧整本删除预览/提交核验最新全表替代状态。Node 22.23.2 构建、311 项全量回归及现有真实读取 38 份生成物的离线兼容核验通过，未执行真实模型发布或 VPS 迁移，见 2026-10-23 分表发布记录。

- Source imports 新增 SFTP / Library / WeCom 子 Tab，一次只显示一个导入面板，URL 保留选择，支持键盘切换；导入与后台轮询逻辑不变。Node 22.23.2 构建、8 项既有界面回归及隔离浏览器切换/刷新验证通过，见 2026-10-23 子 Tab 记录。

- 新增 WeCom imports：官方 CLI 只读采集普通在线表格/Word，不经过 MCP 或 AI；工作簿版本预检、完整分块/隐藏表/公式/链接/合并范围校验、前后版本一致性及逐表文字 Hash，仅变化 Markdown 投递到 newly_added。独立 JSONL Settings、跨进程锁/停止/待投递恢复、管理员 API 和每日北京时间 04:00 service/timer 模板；共用 helper 扩为 SFTP/Library/WeCom 三个固定 timer，安装前须创建三处 drop-in。Node 22.23.2 构建、298 项全量检查及隔离浏览器交互通过；已授权 Guide 的 38 表/4,065 个非空单元格/635 个合并范围与原件一致。真实 Word、独立 VPS 授权刷新及 Ubuntu systemd 未验证，见 2026-10-23 记录。

- Library imports 新增仅定时管理的 Settings，与 SFTP 共用既有 socket/helper，初始通过固定双 timer 白名单（后续 WeCom 扩为三项）独立读取/保存每日或每周北京时间、启用/暂停。沿用版本冲突、原子 drop-in、状态核对/失败回滚；VPS 需更新 root-owned helper 副本及模板，并创建两处固定 drop-in 目录。Node 22.23.2 构建与 36 项定向检查通过；真实 VPS systemd 未验证，见 2026-10-22 Library 定时设置记录。

- SFTP imports 的 Run now 左侧新增 Settings：可编辑配置中的 JSONL，显式 Check 校验格式/path/重复项，未通过或改文后未重检禁止保存；后端重检、版本冲突、原子保存、备份及既有跨进程导入锁。另可查看/调整现有 timer 的每日/每周北京时间及启停，使用固定单元的 root-owned Unix socket helper，不新增调度器或开放任意命令。需在 VPS 一次性安装两份 helper unit 和独立编译脚本，无 npm/env/主服务权限变更。Node 22.23.2 构建、31 项定向检查及隔离浏览器交互通过；真实 VPS systemd 未验证，见 2026-10-22 SFTP 设置记录。

- SYNC 视觉请求单次等待至少 180 秒（聊天不变），仅单次请求超时最多重试一次，仍受原整体截止和请求预算约束；错误注明页码/区域及超时类型，保留已有区域缓存和转换版本。运行逻辑仅改 converter 与 Web 的 SYNC 配置，无新依赖/env/systemd 修改。Node 22.23.2 构建、46 项定向检查及原 18 页 PDF 的本地渲染/模拟超时恢复通过，未调用真实模型、发布或部署；见 2026-10-22 视觉超时记录。

- 修复 SYNC 相同哈希提前 Duplicate 导致跨型号来源遗漏及反馈被忽略：重复报告可复核产品覆盖，核验发布来源后复用正文；新增受限 associate 方案，由后台只追加共享节点/产品 Hub/index/log，预览确认后生效。保留原正文与已关联型号，旧报告/已清理原件兼容；无 env、依赖或 systemd 变更。Node 22.23.2 构建及 35 项隔离/模拟回归通过，未运行真实模型或修复 VPS 数据；见 2026-10-22 产品来源关联记录。

- 修复 Library imports 在 systemd 独立 ReadWritePaths 挂载间硬链接触发 EXDEV：新下载改用 `newly_added/.library-import-work/` 隐藏暂存，日志/状态/分类缓存仍在 `.data/logs/library_sync/`。仅对旧报告能证明的失败 EXDEV、身份/哈希匹配且目标不存在的待发布项迁移恢复，保留权限范围及不明确崩溃时的人工审查。沿用要求未构建或运行测试；见 2026-10-21 资料库发布 EXDEV 修复。

- Library imports HTTP 请求补充 `User-Agent: Mozilla/5.0`，修复 UROVO 文件源站拒绝无 User-Agent 请求的兼容问题；匿名重定向继续携带 UA，API 管理员凭证仍不向下载地址转发，DNS/HTTPS 校验保留。无依赖、env 或 systemd 修改。基于本机 HEAD 对照定位，本轮未构建/执行新增模拟测试或实际下载；见 2026-10-21 资料库下载 User-Agent 修复。

- 修复 Library imports PDF 校验 worker 的 TS2353：移除锁定 PDF.js 6.1.200 已不支持的 `isEvalSupported` 初始化参数，保留字体与严格解析配置，不升级依赖或绕过类型检查。依据管理员 VPS 编译报错及本机依赖类型/源码检查修正；本轮未运行构建或测试。见 2026-10-21 PDF 校验编译兼容修正。

- 补齐 `deploy/product-expert-sftp.service` / `.timer`，原样保存管理员提供的 VPS 配置：root 运行既有 dist CLI，每天北京时间 03:00，Persistent 补跑，128 MiB JS 堆、256M 服务内存、50% CPU、2h 超时。README/SFTP 说明补充安装与仓库/VPS 配置的区别；未改动 VPS、未安装启用或执行验证。见 2026-10-21 SFTP 模板同步记录。

- 独立 Library imports：Synchronize → Source imports 网页入口及 `/api/library-import/*` 管理员接口，最新完整资料库报告 added/updated 合并当前元信息、五类 AI 分类缓存、100 MiB 四格式串行下载/结构校验、来源哈希去重与版本保留、跨进程锁/停止/恢复。`npm run library:import` 直接运行已有构建；新增每周一北京时间 06:00 的独立 service/timer 模板（未安装/启用），状态报告放 `.data/logs/library_sync/`。本轮按要求未运行构建、测试或真实请求，见下方 2026-10-21 资料库导入记录。

- Synchronize 替换/删除时只要求复核直接引用旧来源的页面，不再把 Hub/`index.md` 的间接引用扩散到无关产品页。SFTP 远端同路径有新内容且旧副本仍在 Incoming 时原子覆盖该文件，不再另存 `__sftp_…` 后缀；Sync 已消耗原件后的后续变更仍作为新 Incoming 文件。

- Memory Injection 支持单份30MiB图片/文档/UTF-8文本附件，可替换/移除；专用 Agent 复用现有文件读取与视觉能力，先读取证据，再预览确认主记忆。更换附件须重新预览，文件留在隔离临时存储。本轮未执行验证。见 2026-10-21 主记忆单附件记录。

- Synchronize 待决报告新增问题与动态单选卡片，保留补充输入和显式 Re-Sync；依据默认折叠，旧报告明确选项行可直接展示为卡片。选项仅为草案，不自动授权或提交。本轮未执行验证。见 2026-10-21 待决选项界面记录。

- WeCom Bridge 进入聊天静默；收到消息的排队/等待提示统一为 `AI Thinking...`。本机 Agent API 无法连接或返回 502/503/504 时回复“服务正在升级中，请稍后尝试。”；后端离线不阻止 Bridge 启动，运行中未知结果继续恢复且只通知一次。见 2026-10-21 企微提示调整。

- Synchronize：超大幅面 PDF 页（如 4032×2896 pt 宣传页）不再因 2× 渲染超 2000 万像素失败，改为自动降到不低于 1×（72 dpi）的倍率并记录在覆盖说明；1× 仍超限才拒绝。Incoming files 每行新增 Delete，任务运行时禁用；删除后该文件的 Re-Sync 提示需重新上传。转换 worker 渲染后立即释放 pdf.js 页面、复用切块画布并逐页 GC（`--expose-gc`），i9600 宣传页峰值 RSS 由约 1.09 GB 降到约 0.68 GB，避免触发 systemd 1100M 上限被 SIGKILL。视觉切块请求附带整页尺寸及哪些边与相邻块重叠，提示模型只把真实页边截断或不可读内容列为问题，修复多块页面因内部边缘文字被切而整份失败；报告标签不变，转换缓存版本不变。VPS 升级到 2 vCPU/4 GiB，`deploy/product-expert.service` 改为 MemoryHigh=2200M、MemoryMax=2600M、MemorySwapMax=512M。前端遇到代理返回的 HTML（502/504）显示可读提示，轮询恢复后自动消失。

- Synchronize 新增 Library Tab：递归浏览知识库（跳过点路径与符号链接），Markdown 预览/源码查看；`.md`/`.txt`（≤2 MiB，含 MEMORY.md）可编辑，保存前显示 diff，按打开时哈希防覆盖，写锁内原子写入，旧版备份到 `maintenance-backups/library-edits/` 并追加 `edits.jsonl`。Sync 运行时、`newly_added/`、SKILL/SYNC/SYNC_PROMPT.md 只读。手工编辑不重新校验索引。

- Synchronize 减少无效人工确认：`finish_sync` 当场校验并一次返回全部问题供 Agent 自修（最多 3 轮）；Hub 按目录名自动对应（空格/标点差异）；`oldPaths` 原件路径映射到 Markdown；`index.md` 仅新建 Hub/shared 时强制。Needs your decision 只表示业务问题，校验/过期失败改为 Failed。Re-Sync 原地重跑同一报告并保留尝试历史，删除预览同样原地重生成。

- Synchronize：维护工作表上限独立 200，内嵌 XLSX 按管理员要求跳过并报告；非同名现有 Hub 逐文件预览确认；后台追加审计日志，提供带基线校验的局部索引编辑；区分转换/等待/分析状态，删除预览不再显示 Reconvert。详见 2026-10-21 批次维护修复记录。

- Prompt 管理弹窗预览完整上下文组成、Standard/MCP 差异及实际工具定义；管理员可维护逐条系统指令。指令通过统一组装模块在每个 run 读取快照并注入 system，已有 session 下一 run 生效。详见 2026-10-21 Prompt 记录。

- Synchronize 新产品待确认报告支持 AI 生成逐文件建议指令，管理员点击填入、修改后再显式 Re-Sync。建议不作为权限或自动反馈，不新增模型连接、配置项或批量授权。详见 2026-10-20 新产品建议记录。

- SFTP活动任务保留停止轮询定时器的进程引用，任务结束再清理，修复Node 22等待停止/超时时进程提前退出及测试连带取消。新增独立子进程回归，详见2026-10-20 Node 22修复记录。

- Synchronize新增Source imports独立Tab及手动SFTP单次拉取；JSONL仅path，凭证在.env，哈希去重、串行原子投递、跨进程锁/停止/恢复，持久报告放.data/logs/sftp_sync。暂不启用定时与企微通知。详见2026-10-20 SFTP记录。

- Web/WeCom聊天附件开放受控UTF-8纯文本（TXT/MD/LOG/JAVA/JSON/CSV/HTML/XML/YAML/PY/JS/TS等），复用read/grep并提供绝对readPath，流式编码校验；聊天30MiB保持，不新增工具，部署需重启主服务与Bridge。见2026-10-20纯文本附件记录。

- Memory Injection对话框新增Download Memory File，管理员可下载当前已保存的主MEMORY.md原文，不调用模型、不导出预览或extra。见2026-10-20主记忆下载记录。

- 新增管理员Memory Injection单对话框：自然语言判断主记忆ADD/UPDATE/DELETE，疑问澄清、逐条预览再确认；记忆工具仍只写MEMORY_EXTRA。主MEMORY需移除systemd只读挂载，由后台固定路径发布和备份。见2026-10-20主记忆管理记录。

- Synchronize 文本维护与聊天共用.env的MODEL_ID/BASE_URL/API_KEY；曾临时指定Pro的改动已按用户要求撤回，视觉继续沿用.env中VISION_LLM_*。见2026-10-20维护模型回退记录。

- Synchronize 视觉分块在完整覆盖后停止，末块贴边，避免额外细条触发视觉HTTP400；错误报告加入区域与脱敏后的接口原因，转换缓存版本更新。见2026-10-20切图修复记录。

- Synchronize 保留三个维护 Tab，另增 Source imports；忽略 README.md；维护上传单独固定100MiB，聊天30MiB保持原配置，无需新增环境变量。见2026-10-20后续记录。

- 新增管理员 Synchronize 独立页面及 `/api/sync/*`：手动导入、维护专用 Pi Agent、完整转换与视觉覆盖、索引校验和事务发布、报告反馈/Re-Sync、自然语言删除预览确认。共享知识读写锁，问答工具排除未发布目录。原生 LibreOffice/fontconfig 依赖、systemd 保护范围调整及 `check:sync`/`test:sync`。见 2026-10-20 记录。

- ProductExpertCloud 默认要求 `.data/urovo-product-expert/SKILL.md` 和 `.data/memory/urovo-product-expert/MEMORY.md`，每轮读取新快照并在模型请求注入完整内容，缺失时在推理前报错。ums-expert 改为可选普通 Skill，按需读取正文，无专属 MEMORY 加载。详见 2026-10-18 UMS 按需记录。
- 每次模型上下文最多五轮，包含本次请求；完整保留轮内工具调用关系。过滤历史压缩/分支摘要并关闭自动压缩，避免摘要带回窗口外对话。磁盘历史不按五轮裁剪。
- 会话文件按最后活动时间保留 30 天，在启动、创建会话及运行中每小时清理。支持显式 cleanup；同进程执行中的 prompt 受保护，过期对象不能静默重建无头日志。仅处理 sessionsDir 内已识别的 JSONL，会话目录由一个服务进程独占使用。
- 增加 `AgentRuntime.cleanupSessions()` 和 `dispose()`；保留 SDK Session 返回类型，但安装 prompt 并发检查、上下文策略和模型请求注入。传入 SessionManager 的文件需位于配置的 sessionsDir 下。
- 两个优化后的通用技能模板纳入 resources，业务知识和记忆继续留在 Git 忽略的 `.data/`。新增了仅本机监听的 HTTP Web 测试服务；未新增企微接入或 VPS 部署。

- 新增本地 Web 测试台，复用现有 Core；模型配置、新建/恢复会话、流式回复、停止、Markdown 展示及请求上下文检查。详情见 2026-10-17 记录。

- Web 在 Agent 设置中统一选择 DeepSeek 的 off/low/high/max，初始默认 low；API 保留显式每轮 effort 兼容。实际请求参数及 SDK reasoning 回传适配同时生效。新增随 session 保存的运行强度、状态、总耗时和首段文字等待，元数据不进入模型上下文。详见 2026-10-17 后续记录。
- 每条回答新增本轮工具调用次数和按需展开的调用详情；沿用 SDK JSONL 保存参数/结果，仅补充逐工具耗时元数据。支持旧记录、失败/停止/中断恢复，详情不含模型思考。见 2026-10-18 记录。
- Core 新建/恢复会话只启用 Pi 内置 read/grep/find/ls，禁用模型可调用的 Bash、PowerShell、edit、write。两个运行 Skill 与模板改用工具参数检索；可选文件模块启用时另有读取路径限制及文件 worker 隔离，关闭时保留原读取行为。见 2026-10-18 只读工具记录。
- 两个 Skill 默认仅在用户明确要求时展示来源；Web 新增会话重命名/删除并写入或删除原 JSONL，右侧调试面板全尺寸默认收起，支持按需展开。见 2026-10-18 后续记录。
- Web 新增 ADMIN_ACCOUNT/ADMIN_PASSWORD 单管理员登录，页面与 Agent API 需要有效登录 Cookie；保留本地 Token/Host/Origin 校验，未配置管理员时默认拒绝访问。见 2026-10-18 登录记录。
- 每轮额外注入 `.data/memory/urovo-product-expert/MEMORY_EXTRA.md`，通过单个 memory 工具的 action=add/edit/delete 管理；产品 Skill MEMORY 和保留的历史 UMS MEMORY 均不由该工具写入，基础工具五个，资料库链接检索独立开关默认开启后为六个（可选文件模块再加最多六个）。带版本检查、同进程写入队列、原子保存和备份。见 2026-10-18 额外记忆记录及后续合并修正。
- 系统提示及 memory.content 参数说明以软约束要求记忆正文标题从三级（###）起步，不新增硬校验或改写已有记忆。见 2026-10-18 标题规范记录。

- 可选文件模块新增六个专用工具及 Web 上传/下载；受控 session 文件存储、串行任务队列、独立视觉配置和 Ubuntu worker 镜像。开关默认关闭，关闭并恢复旧会话仍为基础工具（资料库链接独立开关开启时六个、关闭时五个）；文件模块最多再加八个（新增两个创建工具默认关闭），并收窄原生读取路径。见 2026-10-18 文件工具记录。

- 附件支持按用户消息绑定（图片/PDF/DOCX/XLSX/PPTX）、待发送区与消息下展示，JSONL custom entry 保存关联；会话过期与手动删除同步清理全部附件，即使工具开关关闭也生效。见 2026-10-18 消息附件记录。

- Web 模型连接编辑入口与保存接口已撤下，模型参数仅通过 .env/进程环境启动读取；Agent 设置提供全局强度、六文件工具总开关及独立开关，保存到 .data/web-agent-settings.json，立即应用后续请求且重启保留。见 2026-10-18 Agent 设置记录。

- Excel 输出由后端直接登记 generated-file-v1 JSONL 关联到 run/用户消息/工具调用，回答下显示可下载文件卡片；支持实时通知、多文件、失败/停止后保留、重启与旧工具结果恢复，不依赖模型文本路径。见 2026-10-18 输出交付记录。

- Ubuntu production 不再强制 Docker：FILE_WORKER_IMAGE 为空使用原生任务子进程，显式镜像仍选容器；新增 /opt/ProductExpertCloud 的 systemd 模板与原生部署步骤。见 2026-10-18 VPS 原生部署记录。

- Excel 模板写入正确区分自闭合空单元格/行，发布前独立验证行/单元格/样式及目标值完整性；失败不发布，详见 2026-10-18 Excel 空单元格写入修复。

- Office 预检按 BOM/字节签名解码 UTF-16 元数据，不再强制 UTF-8 导致误拒绝；精确匹配含空格的工作表名。见 2026-10-18 Office XML 编码兼容记录。

- 单文件上传默认30MiB，Excel/图片原件输入统一遵循FILE_MAX_BYTES，前端动态提示；见2026-10-18上传上限记录。

- Web 登录固定有效期为7天，Cookie与服务端过期时间一致；原重启清空行为已由2026-10-23签名摘要持久化修正，历史有效期调整见2026-10-18记录。

- 新增可选企微长连接 Bridge、专用本机 API 和 Web/企微共用的有界并发队列；复用现有文件工具并结构化回传生成文件，systemd 使用 product-expert 与 wecom-bridge 两个独立服务分别管理。详见 2026-10-18 企业微信接入及独立启停修正记录。

- Web 新增 WEB_PUBLIC_URL 显式 HTTPS 域名来源配置，支持反代登录并保留本机入口、登录/CSRF 与 Secure Cookie。见 2026-10-19 HTTPS 域名登录修复记录。

- 企微联系人改为独立 /wecom-contacts 页面，累计实际开始的提问轮次及已收到的模型 usage（输入/输出/总量），群聊按提问者归属，缺失明确标注，删除会话保留累计数据。见 2026-10-19 联系人统计记录。

- Web 新增企微联系人列表和独立 User ID 备注；Bridge 可按接收人配置转发其他用户消息，通知使用“对话人”备注而非会话标题，独立持久队列去重/重试。见 2026-10-19 企微联系人与消息通知记录。

- 新增可选联网工具 `search` / `fetch`，通过DeepSeek固定HTTP接口按需搜索/读取公开网页；当前Web仅保留两个独立开关，初始均关闭，Web/企微共用，最多再加两个工具。见2026-10-19联网工具及英文界面记录。
- 新增默认工具 `get_file_link_from_library`，按当前用户原文调用固定资料库 API 返回文件/软件下载链接，Web/企微共用，独立于文件处理开关，Web Agent 设置支持单独启停并持久化，旧设置默认开启。见 2026-10-19 资料库链接工具及开关记录。

- 新增默认关闭、可显式启用的文本 MCP `/mcp`（现已增加MCP_API_KEY Bearer鉴权，见后续记录），三个任务工具复用Core与共享执行队列；逐任务/会话/累计Token持久统计，管理员Settings现整合MCP四项累计及持久开关（原独立页面重定向）。MCP禁用文件处理及记忆写入。详见2026-10-19文本MCP记录。

## 2026-10-16 — 默认专家资源、五轮上下文与 30 天会话保留

原因：用户要求产品专家和 UMS 技能默认生效，每个 run 强制加载技能与对应 MEMORY，并限制聊天上下文和磁盘历史生命周期。

行为/兼容性影响：所有新建及恢复会话采用上述策略；缺失必需资源会拒绝启动或执行。每轮读取磁盘，下一轮可见修改；技能/记忆不写入会话历史。UMS 新增明确无额外业务条目的 MEMORY；产品 MEMORY 原文不变。并发 prompt 不再排入 SDK streaming 队列，需要上层按会话排队。关闭自动摘要意味着超过模型容量时不会自动保留旧摘要，也不会静默截断记忆。当前默认文件/命令工具权限没有改成系统沙箱。

验证：本机类型检查、构建、8 项行为测试通过。测试使用本地模拟模型 HTTP 端点，覆盖请求中完整技能/记忆、热更新、五轮窗口、工具配对、恢复、缺失资源阻断、并发、隔离、启动清理和运行保护；两个技能通过 skill-creator 格式校验。尚未做真实模型问答、Ubuntu 或 VPS 验收。后续修正继续追加记录。

业务数据维护：目标 `.data/` 中两个 SKILL 已更新，旧版本保存在 `.data/maintenance-backups/2026-10-16-default-skills/`；初始化 UMS MEMORY，无业务事实编造；源 patrick-agent 未修改，知识资料和密钥未加入 Git。详见 `dev-history/2026-10-16-expert-session-policy.md`。

## 2026-10-17 — 本地 Web Agent 测试台

原因：用户要求提供 Web 界面测试现有产品专家 Agent 的效果。

行为：新增 `src/web/server.ts`、`cli.ts` 和 `resources/web/`，通过 `npm run web` 启动，仅监听 `127.0.0.1:4321`（WEB_PORT 可覆盖）。复用原 runtime/session 策略，无单独模拟业务 Agent。界面提供流式聊天、会话列表和恢复、停止、Markdown/表格、模型设置与上下文检查。检查数据取自组装后的实际模型请求，统计技能和 MEMORY 注入各一份、最多五轮、请求次数与序列化字节；不把字节误称 token，也不把“已配置/可读取”当成模型连接或业务成功。

配置/兼容性：原库导出和 Core 工具权限不变。新增 marked、DOMPurify 作为本地静态资源；默认无外部前端 CDN。模型密钥仅在后端，显式勾选时原子保存到权限 600 的 `.env`，不回传密钥。模型改配阻止与运行/初始化并发；后端 Host/Origin 和页面 token 限制本机请求，不提供生产多用户身份。断开页面会中止该页面运行中的请求。没有公开部署、企微接入、真实模型验收或自动升级依赖漏洞。

验证：类型检查、构建、前端 JS 语法检查与全部 13 项本地测试通过。新增 Web 测试覆盖配置持久化和权限、不泄漏密钥、跨站/Host/令牌校验、静态资源边界、流式问答、请求注入统计、六轮窗口、重启恢复、重复请求/改配冲突和停止。浏览器实际验证首次未配置状态、设置表单、窄屏上下文抽屉；隔离模拟模型浏览器联调验证发送、Markdown 表格、刷新恢复及危险脚本/图片清除。没有将模拟回答当成产品正确性验收。

## 2026-10-17 — Web 思考强度切换与逐轮耗时

原因：用户要求在 Web 增加强度按钮用于比较效果，并记录每轮 run 的时间。

行为/兼容性：输入区新增快速（关闭思考）、标准（low，默认）、深入（high）、深度研究（max），按请求锁定，执行中禁用切换。DeepSeek provider 注册启用强度参数、映射及 reasoning_content 回传；最终 onPayload 再明确应用思考开关和强度，检查面板显示实际组装值。新增 `effort` 请求字段；DeepSeek 未传时默认 low，其他模型保持供应商默认并禁用按钮，显式不支持/非法值返回 400。

计时：每个新 Web run 保存开始/结束、服务端单调时钟总耗时、首段文字等待、模型、选档、轮次及完成/失败/停止状态；输入区实时显示，消息旁和右侧运行记录可查看。SDK custom entry 存于原 session JSONL，不加入模型上下文、不影响五轮；沿用原 session 的 30 天清理。旧轮次不伪造耗时；有开始无结束的历史记录展示中断/未知耗时。计时含有效 run 请求被接受后的准备、检索、模型/工具与重试，不含此前独立新建会话请求和浏览器网络耗时。

验证：类型检查、构建、前端语法及全部 17 项本地测试通过；新增覆盖四档最终 HTTP 参数、默认/非法/不支持行为、延迟计时、刷新/重启恢复、失败/停止记录、max 到 off 切换及工具循环 reasoning_content 兼容。浏览器隔离模拟环境验证档位切换、运行时按钮锁定、实时秒表、结束后时间和强度展示、刷新后的记录恢复。未调用用户真实模型、未比较实际速度或回答质量；未修改 .env、业务记忆和源 patrick-agent。

## 2026-10-18 — Web 工具调用计数与可展开详情

原因：用户需要对比 Agent 效果，每条回答能看到工具调用数量，并逐条展开调试参数、结果、状态与耗时。

行为/兼容性：回答操作区新增“工具调用 N 次”“查看工具调用”；调用卡片默认收起，标题含序号、工具名、参数摘要、状态、耗时，展开查看调用 ID、开始/结束、完整已记录参数和结果/错误及结构化详情。详情通过新增 GET `/api/sessions/:id/runs/:runId/tools` 按需加载，按当前会话/轮次查找，主会话/SSE 完成响应仅携带计数与引用，模型思考不参与展示。无文字但有工具调用的轮次显示可调试的占位回答。检查面板和最近五轮记录也显示调用数量。

持久化：复用原 SDK 消息，不另存一份工具输出；`web-run-metrics-v1` 增加可选逐工具时间数组，起止时追加快照，及时保存轮次关联。五轮上下文及 30 天会话保留不变。旧 JSONL 无需迁移即可按轮次恢复调用，未测量耗时显示“耗时未记录”。计数为本轮模型发出的 toolCall 数量，包含失败或未完成的调用，不等同于模型请求数。工具本身截断过的内容只能展示原日志实际保存部分。明确停止时优先记录 stopped，修正原 SDK 以 error 收尾造成的误分类。

验证：构建、类型与前端语法检查、21 项本地测试通过；新增四项覆盖多步骤/同名/失败调用的顺序和计数、逐工具计时、跨会话隔离、五轮后仍可查原详情、按需响应、无工具、重启恢复、旧记录缺失计时、工具执行中停止和中断记录恢复。浏览器隔离模拟模型验证查看/收起、单项展开、刷新恢复，以及含 script/img 的工具输出只显示纯文本。未调用用户真实模型，未修改 .env、业务知识与 patrick-agent。

## 2026-10-18 — Core 切换 Pi 内置只读工具

原因：用户要求先采用 Pi 的四个只读工具，防止通过问答指令调用 Bash 或写入工具破坏知识库，同时保留文件/内容检索。

行为/兼容性：`createAgentSession` 显式工具集由 read/bash/edit/write 改为 read/grep/find/ls；新会话和恢复历史会话均生效。未知的 Bash/PowerShell/edit/write 调用由 SDK 拒绝，不仅依赖提示词。系统提示及两个 Skill 指引改用 read 的 offset/limit、grep 的 context/limit、find 的 glob/limit 和 ls，不再建议 shell 管道、文件生成或在线知识维护。Web 工具活动显示新增三个只读工具中文标签；旧日志中的命令/修改调用仍可查看。原来依赖 shell 或写文件的任务不再可执行。

边界：本轮仅限制模型工具能力，没有做可读目录约束、符号链接隔离、容器或操作系统级只读挂载。知识库目录以外的读取仍需后续限制；应用自身正常保存 session/运行指标及清理过期日志的权限不变。grep/find 底层依赖 SDK 提供的 rg/fd，使用结构化参数，不把用户输入交给 shell。

业务数据维护：同步更新 `.data/ums-expert/SKILL.md` 和 `.data/urovo-product-expert/SKILL.md`，修改前备份于 `.data/maintenance-backups/2026-10-18-readonly-tools-001449/`；两个 MEMORY 和知识 Markdown 未修改，源 patrick-agent 未修改。代码/模板纳入版本管理，运行数据与备份继续忽略。

验证：构建、前端语法、diff 检查及 23 项本地模拟模型测试通过，两个 Skill 模板通过格式校验。新增验证实际 HTTP 仅包含四个工具，强行发送 Bash/PowerShell/edit/write 调用均返回 not found，临时受保护文件内容及不存在文件状态不变，重启恢复后工具集不变；read/grep/find/ls 在 Git 忽略的 `.data` 知识目录中均成功执行。原工具详情测试改用 ls/read，停止测试验证只读检索后停止及记录恢复。未调用真实模型，未完成 Ubuntu/VPS 或系统沙箱验收。

## 2026-10-18 — 默认隐藏来源、会话管理及调试面板收起

原因：用户要求简化最终回答和聊天界面，并增加持久化的会话重命名与删除。

回答规则：两个 Skill 模板及实际运行副本增加“除非用户明确要求，否则最终回答不包含来源、路径、引用标记或参考列表”。内部仍检索和核对，保留必要的不确定性与冲突说明；要求引用时提供实际读过的来源。同步移除比较建议问题中自动添加的来源要求。规则由 Skill 注入模型，不是前端删除文字，不改写已有回答。

会话接口/持久化：新增 PATCH `/api/sessions/:id` 接收 title（去首尾空白、1–80 字符、禁控制字符），以 SDK session_info 保存，名称不加入模型上下文。空会话在重命名时立即保存 SDK header/entries 并释放未刷盘对象，下次通过 SDK 重新打开，避免重启丢名或首次运行重复建文件。新增 DELETE 同路径，按服务端 ID 解析路径，只处理 sessionsDir 内普通 JSONL，拒绝符号链接；成功后清文件、对象缓存并标记已删除，旧页面不能继续恢复或运行该 ID。运行/初始化中的目标会话返回 409，管理操作与运行/改配互斥；延续 Host/Origin/token 检查。已保存会话的管理不依赖模型启动或知识资源可用。

界面：左侧每条会话提供 ⋯ → 重命名/删除，删除确认框说明消息、工具调用、指标一起永久删除；删除当前会话后清空画面和浏览器选中 ID。右侧面板默认隐藏，在顶部“调试信息”按需展开，保留回答旁的强度、耗时和工具次数。窄屏提供会话抽屉入口。原始 JSONL 格式兼容，未引入数据库或新依赖。

业务数据维护：修改前的两个 SKILL 备份于 `.data/maintenance-backups/2026-10-18-source-display-003854/`，同步后与跟踪模板一致；MEMORY、知识正文、.env 和 patrick-agent 未改。

验证：构建/类型、前端语法、diff 检查通过；29 项本地模拟模型测试通过。新增六项覆盖名称写盘/重启/不入模型上下文、空会话重命名后运行、删除 JSONL/缓存/工具指标并防恢复、活动会话与请求权限限制、知识缺失时仍可管理、符号链接和未知 ID 边界。两个 Skill 格式校验通过。隔离浏览器验证菜单、重命名保存与刷新恢复、删除确认/取消、调试面板展开与关闭及默认隐藏；未删除用户实际会话，未调用真实模型验证引用遵循效果。

## 2026-10-18 — Web 管理员登录

原因：用户要求在 .env 与 .env.example 增加 ADMIN_ACCOUNT、ADMIN_PASSWORD 作为 Web 登录账号密码。

配置/界面：两个字段从显式 WebOptions.admin、进程环境或 .env 读取，启动时固定；均需填写，不生成默认或弱口令。新增 /login 页面及退出入口，未配置或仅配置一项时提示填写配置并重启，Agent API 保持拒绝访问。本机 .env 仅补入缺少的空字段并保持 600 权限，原模型配置值未改变；实际凭据未提交 Git。

认证/接口：新增 GET /api/auth/status、POST /api/auth/login、POST /api/auth/logout。登录成功颁发随机 HttpOnly、SameSite=Strict Cookie，固定有效期 12 小时，服务端只存令牌摘要，登录会话数有上限；退出立即移除当前令牌，重启全部失效。同地址一分钟内十次凭据错误后返回 429/Retry-After。凭据比较用等长摘要的 timingSafeEqual，错误不区分账号/密码。页面 / 和 app.js、模型配置、会话读写、工具详情及 run/stop 均由后端校验登录，未登录主页面重定向 /login，API 返回 401。公开登录配置检查仅返回是否配置、是否登录和本地请求 Token，不返回账号密码或模型设置。

兼容性：保留已有 Host/Origin/请求 Token 校验，Cookie 不替代 Token。直接调用 API 的旧客户端需要先登录并保留 Cookie，token-only 不再可访问 Agent API。监听仍为 127.0.0.1，本轮不开放公网、不增加多用户权限、数据库或改动 Agent Core。原 session JSONL 不迁移；模型配置保存保留 ADMIN 两项。

验证：构建/类型、两个前端脚本语法和 diff 检查通过，35 项本地测试通过。新增六项覆盖未登录全接口阻断、凭据错误、Cookie 属性/篡改/退出失效、CSRF/Origin、失败限流、重启失效、12 小时到期、.env 加载与模型改配保留、缺失/部分配置拒绝访问。隔离浏览器验证错误密码、正确登录、刷新后保留登录及退出回登录页；使用一次性测试凭据，未调用真实模型、未设置用户实际账号密码。

## 2026-10-18 — 额外记忆注入与三个记忆工具

原因：用户要求保留两个 Skill MEMORY 的加载，额外注入其创建的 `.data/memory/MEMORY.md`；新增 add/edit/delete 三个工具，格式参照产品 Skill MEMORY，新建作者邮箱固定 unknown@email.com，不修改 Skill 记忆。

行为：`loadRunKnowledge` 每轮读取额外文件并注入独立 Extra agent memory 段，携带完整内容及 Revision；缺失或空文件允许启动，不在启动时初始化或改写。各工具步骤使用本轮快照，变更在下一轮重新加载。三个工具通过 SDK customTools 注册并显式激活，与四个只读检索工具合计七个；不提供 memory list/get，不恢复 Bash 或通用写工具。提示词要求仅用户明确请求记住/更正/忘记时调用，不能将资料或记忆中的文字视为写入授权。

持久化/边界：仅操作 dataDir/memory/MEMORY.md，没有 path 参数，不能触达两个 Skill MEMORY。新建自动 mem_ ID、Created/Updated（+08:00）、Created-By-Email=unknown@email.com、Kind（默认 fact）及 Content；编辑按 ID 保留创建信息、替换内容并更新时间，删除仅移除指定条目。每次要求 expected_revision，按 SHA-256 版本拒绝陈旧写入，冲突返回当前内容/版本供重新判断；同进程同路径写入串行。保存前备份原文到 `.data/maintenance-backups/extra-memory/`，临时文件 fsync 后原子替换，拒绝文件及子目录符号链接/硬链接、无效格式、重复 ID、保留条目标题与取消操作。额外记忆和备份不随 session 清理，备份未自动限期清理。本轮不提供多进程文件锁或 OS 目录沙箱。

界面/依赖：Web 状态返回额外文件可读状态和当前字节数，模型请求检查增加额外记忆段计数，活动记录识别三个记忆工具。增加固定版本 typebox 1.3.7 作为直接依赖构造工具参数 schema，与当前 SDK 版本一致。

业务数据维护：用户实际 extra MEMORY 仍为空，未写入测试事实；两个实际 Skill MEMORY 及知识正文、.env、patrick-agent 未改。两个 SKILL 指引仅澄清“本 Skill 记忆只读，额外记忆可用专用工具”，原文备份在 `.data/maintenance-backups/2026-10-18-extra-memory-skill-scope-013834/`，运行副本与模板同步。

验证：构建/类型、前端语法、两个 Skill 格式与 diff 检查通过；41 项本地测试通过。新增六项覆盖格式/元数据/备份、增改删、并行冲突、无效格式与取消、链接绕过、原生 SDK 工具调用、下一轮加载和同轮快照、恢复后可操作、路径参数与 Skill ID 拒绝，断言 Skill MEMORY 字节不变。既有五轮/七轮恢复测试增加额外记忆各一份与热更新验证。修正 .env 测试隔离，避免真实进程环境覆盖临时测试凭据/模型值。隔离浏览器通过模拟模型验证 memory_add 写入、工具记录及三份记忆检查；未调用用户真实模型。

## 2026-10-18 — 记忆接口合并为一个工具（修正）

原因：用户澄清需要一个记忆工具，通过参数选择三种操作；之前将三个操作拆成三个独立工具的理解不符。

行为/兼容性：仅注册 `memory`，action 限定 add/edit/delete。新增要求 content 且不接受 id；编辑要求 id/content；删除要求 id 且不接受 content/kind；三种操作均保留 expected_revision。工具总数从七个调整为五个。旧 memory_add/edit/delete 名称不再可调用，原日志仍可查看；记忆文件、条目 ID、元数据、版本检查、备份与两份 Skill MEMORY 只读边界不变，无数据迁移。

同步：系统提示、额外记忆注入说明、两个 SKILL 模板与运行副本、Web 活动标签和 README 使用单工具接口。运行 SKILL 修改前备份在 `.data/maintenance-backups/2026-10-18-single-memory-tool-014510/`；未改业务记忆正文、.env 或 patrick-agent。

验证：类型/构建、前端语法、Skill 格式及 diff 检查通过；42 项本地模拟模型测试通过。SDK 端到端测试使用同一个 memory 名称完成三种 action，并验证恢复、下一轮注入及 Skill MEMORY 不变；新增验证旧工具名、未知 action、缺少或冲突参数全部失败且不写入。未调用真实模型。

## 2026-10-18 — 记忆正文标题软约束

原因：用户要求在提示词中明确记忆正文标题从三个 #（三级标题）起步，区别于“三个标题”的数量要求。

行为/兼容性：系统提示和 memory 工具 content 参数说明加入正文使用 ###、子标题使用 #### 或更深层级，避免 #/## 与文件结构混淆。仅为模型格式指引，不要求纯文本或列表必须带标题，不增加程序标题层级/数量校验，也不格式化已有记忆。原保留条目标题拦截、文件格式、版本与权限校验不变。

验证：构建及 4 项既有记忆存储行为测试通过，diff 检查通过；三份实际 MEMORY 文件修改前后 SHA-256 相同。未调用真实模型验证其遵循程度。

## 2026-10-18 — 可选文件工具、附件界面与 Ubuntu 隔离 worker

原因：用户要求移植 pdf_read、docx_read、pptx_read、excel_read、excel_patch_template、image_read，便于在 Web 调试，计划运行于 2 核 2GB Ubuntu 24 VPS，并可随时关闭模块。用户明确本次落盘和验证目录为 `/Users/patrickxu/ProductExpertCloud`，patrick-agent 仅作为只读来源；本轮不改其文件或执行其构建/生成器/测试。

实现：源解析依赖按所需闭包迁入 src/file-tools/vendor，通过适配层调用，未迁入源 Runtime/数据库/业务持久化。新增 FileTools、独立受控存储、结构化参数、单并发队列、输出限额、取消/超时、转换缓存及每轮视觉预算。默认关闭；启用注册六个专用工具并按需提供五个文件 Skill，共十一个工具。每轮业务 Skill/三份 MEMORY 注入、五轮窗口、SDK JSONL 和 memory 工具不变。关闭并重启恢复原五个工具，既有附件及工具历史仍可读。启用时四个原生读取工具限制为当前会话/专家知识/Skill 根目录，二进制转专用工具；不暴露 Bash、任意写路径或公式覆盖许可。

文件/接口：Web 支持上传 PDF/DOCX/PPTX/XLSX/PNG/JPEG/WebP、附件列表和下载输出，沿用 Cookie、Host/Origin、Token 和会话互斥。新增 GET/POST `/api/sessions/:id/files`、GET `/api/sessions/:id/files/:fileId`。元数据与原件/输出位于 Git 忽略的 `.data/files/<sessionId>/`；上传空会话即保存，支持重启恢复。校验 session 归属、真实路径、链接、类型/配额；工具只接收任务快照，Excel 仅发布新的已验证 XLSX，保留原件、格式/图片和公式。删除会话同步删附件，闲置三十天清理。Markdown 缓存有容量与 24 小时期限。原始图片/Base64 不进入 JSONL，工具详情增加执行/排队、内存和视觉统计。

资源/配置：新增固定版本解析依赖、MarkItDown 0.1.8 与 Python 依赖约束、deploy/Dockerfile.files（Ubuntu 24.04/Python 3.12）和部署文档。Linux production 强制配置 FILE_WORKER_IMAGE；任务容器无网络、只挂载单任务目录、只读根文件系统、1 CPU/768MiB（不额外 swap）/64 进程，无模型密钥、Docker socket 或知识库挂载。视觉请求由主进程通过 VISION_LLM_* 发起；默认文档视觉关闭，图片识别需单独配置。Mac 本机子进程开发模式仅有堆/超时限制，不当作 OS 沙箱。未承诺所有大文件均可处理，也未做真实 VPS 部署/长期负载验收。

业务数据/兼容性：没有改动两个业务 Skill 的 MEMORY、额外 MEMORY 或知识正文；真实测试使用生成的隔离夹具，未写入用户事实。本机 .env 保留原凭据并启用文件开关、设置本机转换器路径，修改前备份于 `.data/maintenance-backups/2026-10-18-file-tools/`；密钥/模型会话/维护备份继续忽略。源项目保持只读。

验证：构建及 51 项本地测试通过，覆盖六个真实格式解析/模板保护、结构/尺寸/合并区域限制、路径/归属/链接/配额、取消、视觉降级/缓存、认证上传下载、重启、删除、开关关闭后的旧会话与原五工具恢复。Ubuntu 24.04 ARM64 一次性容器中五项文件套件通过，确认实际 Docker backend 和 cgroup 峰值；六个小型夹具峰值约 32–139MiB（包含转换子进程），不代表生产最大文件。真实 DeepSeek Flash Agent 成功调用全部六个工具，实际 VISION_LLM 配置识别图片文字；与模拟接口测试分开记录。浏览器验证登录、上传、实际 SDK 读取/另存、下载内容 B2=77、调用卡片与详细记录。详细证据和边界见 dev-history/2026-10-18-file-tools.md。

## 2026-10-18 — 消息附件绑定与会话删除联动

原因：用户要求文字和本轮附件一起发送，明确图片与 PDF/DOCX/XLSX/PPTX 均适用，并要求三十天过期及手动删除会话同步清理全部附件。

接口/持久化：run 接口增加可选 attachmentIds（省略表示没有新附件，最多 20 个、拒绝重复/非法/跨会话/不可读 ID），支持 text 为空但带附件，默认提示分析本条文件。关闭文件工具时拒绝新附件，历史可下载。新 message-attachments-v1 JSONL custom entry 保存 run、用户轮次/时间、最终 SDK 消息 ID 和附件快照；不引入数据库，不改原始用户文本或二进制存储位置。上下文变换在五轮裁剪后给对应 user 消息添加文件清单，记忆注入不变。新上传使用 manifest 的可选 messageScoped 标记，未发送文件不进入模型目录；旧文件兼容保留，不猜测旧消息绑定关系。SSE 新增 message 接受事件；消息视图增加 attachments。

界面：上传先进入待发送区，显示数量并可取消携带；发送后在对应用户消息下显示文件，下一轮不自动重复。当前浏览器按会话保存待发送 ID，刷新/切换会话后恢复；跨浏览器草稿不自动同步。取消携带不删除文件，历史附件和生成结果仍在折叠文件列表中。服务端接受用户消息时才清待发送状态，拒绝请求时保留草稿。删除确认明确包含上传附件、输出、缓存及临时文件，并清该会话浏览器待发送列表。

清理修正：原先 JSONL 和附件按各自活动时间独立清理，现在 SessionRetention 删除已识别过期日志前先删除它的 `.data/files/<sessionId>/`，覆盖 inputs/outputs/cache/work/manifest；附件清理失败则保留日志重试，拒绝符号链接。共享进程锁覆盖异步删除过程，活动 prompt 受保护。有效/活动 session 不会单因目录时间较旧丢附件。Web 启动和每小时独立执行会话清理，不依赖模型初始化、业务资源可读或文件工具开关；显式删除也沿用同一文件目录删除。未知文件、共享知识及 MEMORY 不在清理范围。

验证：构建、前端语法、diff 检查通过，56 项本地测试通过；清理加锁后另跑 17 项 Core/附件用例通过。新增五项测试覆盖五类文件绑定、重启与下一轮不重复、未发送文件不进上下文、七轮后窗口裁剪、只发附件、非法/重复/跨会话/关闭开关、过期联动、有效附件保留、活动运行保护、手动删除全部子目录、符号链接拒绝与删除失败保留日志。既有测试显式关闭文件功能，避免本机 `.env` 开关污染原五工具用例。隔离浏览器验证五文件上传、移除/刷新恢复、一起发送、消息下展示、无附件追问及刷新恢复，截图 `.data/debug/message-attachment-ui/sent.png`。本轮使用本地模拟模型，未调用真实模型、未部署 VPS，patrick-agent 及实际业务记忆未修改。

## 2026-10-18 — Agent 设置替换模型连接编辑

原因：用户要求 Web 设置仅保留全局思考强度及六个文件工具开关，模型地址、名称和密钥由用户自行维护 .env。

界面：所有“模型设置”入口改为“Agent 设置”，删除 API 根地址、模型名称、API Key 和“保存到 .env”表单。弹窗包含快速/标准/深入/深度研究、文件工具总开关与 pdf_read/docx_read/pptx_read/excel_read/excel_patch_template/image_read 独立开关。总开关关闭后子开关禁用但保留选择。输入区原每轮四按钮改为显示全局值及设置入口，移除浏览器 effort 偏好与发送时的 UI effort 覆盖。不支持强度的供应商禁用选择器，仍可保存工具开关；模型未配置时提示修改 .env 并重启。

持久化/接口：新增受认证/Token/Host/Origin 保护的 GET/PUT `/api/agent-settings`，严格验证完整设置及六个布尔项，拒绝模型/密钥或未知字段。设置保存至 `.data/web-agent-settings.json`，普通文件/拒绝链接、mode 600、临时文件原子替换；不改 .env。无已存设置时沿用环境变量的文件总开关及 low 强度，保存后跨会话和重启生效，优先于初始环境开关。原 `/api/config` 返回 410，API 客户端不能继续通过它修改模型；程序化 ModelConfig 和 .env/进程环境读取仍保留。

运行行为：设置更新拒绝与任何运行、初始化、上传或会话变更并发；落盘成功后释放缓存 Agent，下次按相同 session ID 恢复日志并注册新工具集，保留会话、名称、附件及浏览器待发送草稿。单项关闭同时限制 SDK 可见工具及 FileTools.execute，而非仅隐藏按钮；对应文件 Skill 按启用项加载。原 read/grep/find/ls/memory 不受单项开关控制，总关后恢复原五工具；所有文件工具关闭时拒绝新上传/发送附件，历史下载、删除与过期联动继续有效。每轮锁定全局 effort；直接 API 的显式 effort 参数继续优先以保持兼容，Web 不再发送该覆盖字段。

验证：构建及 59 项完整本地测试通过，增加设置文件安全用例后的 Web 定向测试通过（见日志）。实际 SDK 请求验证全局 high/off 参数、新建/恢复会话仅含所选工具、总关五工具、重启保留、会话历史保留；直接执行关闭工具拒绝；验证认证/CSRF/参数/不支持供应商/.env 字节不变。浏览器隔离验证全部六项展示、总开关联动、单项关闭、强度选择、保存与刷新恢复；截图 `.data/debug/agent-settings-ui/settings.png`。本轮未调用真实模型、未修改用户真实 .env/知识/记忆，未部署 VPS。patrick-agent 及 pi-patrick 未修改。

## 2026-10-18 — UMS 改为按需普通 Skill

原因：用户要求 ums-expert 不再像 urovo-product-expert 一样每轮默认加载，也不再具备专属 MEMORY 加载机制；产品专家保持原样。

Core/资源：DEFAULT_SKILLS 仅保留 urovo-product-expert，其完整 SKILL/MEMORY 仍每轮读取、同轮固定快照、恢复后生效、缺失阻断推理；额外 memory/MEMORY.md 注入和 memory 工具保持原行为。ums-expert 通过 SDK 普通 Skill 路径登记实际 `.data/ums-expert/SKILL.md`，系统 Skill 列表只有其名称/简介/路径，相关问题再用 read 读取正文，引用路径相对此文件解析。避免资源模板抢占同名 UMS Skill 导致知识根目录错误。UMS 部署可缺省，不再要求读取其 MEMORY，历史文件保留不删除；已读取的普通 Skill 正文作为正常工具结果沿用既有五轮上下文，不强制重复注入。

指引/界面：同步 UMS 模板和本机运行副本，移除默认注入与专属记忆使用说明，保留检索路由、只读和默认不展示来源规则。共享系统提示/额外记忆说明去掉“两份 Skill 记忆”的假设。Web 默认 Skill 卡改为产品专家一项，UMS 单列为按需/无专属记忆，不再检查其 MEMORY；请求检查验证产品技能、产品记忆和额外记忆各一份。

业务数据维护：修改前 UMS SKILL（运行副本及模板）备份于 `.data/maintenance-backups/2026-10-18-ums-on-demand/`。产品 SKILL、产品 MEMORY、旧 UMS MEMORY 和共享额外 MEMORY 未修改，保留 SHA-256 验证记录；知识正文、.env、patrick-agent 和 pi-patrick 未修改。

验证：构建及 62 项本地模拟模型测试通过，UMS 模板/运行副本均通过 skill-creator 格式校验；新增验证无 UMS MEMORY 仍可启动、名称/实际文件路径可发现但正文不在系统注入、实际 SDK read 可按需读取、恢复后规则一致、UMS 未部署不影响产品请求。七轮/恢复与同轮快照测试改为继续验证产品技能/记忆和额外记忆，每轮 UMS 正文/记忆均未强制注入。未调用真实模型验证自主选择 UMS 的准确率；未部署 VPS。

## 2026-10-18 — 后端登记输出与回答下载卡片

原因：用户确认文件交付应从真实工具执行结果产生，要求前端可直接下载，不依赖大模型在最终文字中返回 fileId 或路径。

实现/持久化：FileTools.execute 在已验证文件经 FileStore.publish 原子写入输出清单后触发受信回调；Runtime 通过实际 SessionManager 写入 generated-file-v1 custom entry，保存后端文件元数据、当前用户消息 ID/轮次、toolCallId 及 Web runId。发布后即登记，早于临时目录清理及工具返回；无模型可控制的登记参数或路径解析器，不新增 SQLite。普通 SDK 运行也可按用户消息关联；Web runId 从现有消息绑定中取得。完整文件仍在 `.data/files/<sessionId>/outputs/`，原件、知识和记忆不变。

Web/API：SSE 新增 output 事件 `{ runId, file }`，文件任务结束后立即通知前端，不必等最终回答。assistant 消息视图增加 outputs/outputNotice，按稳定用户消息 ID 关联到该轮最后一条文字回答；没有文字时生成结果占位。UI 显示“本轮生成文件”卡片、名称、类型、大小及下载入口，多输出同轮展示，旁边仍保留工具详情。模型没有提及文件名或写出虚构路径/fileId，都不影响或产生真实卡片。文件成功发布后模型请求失败/用户停止仍可下载，并区分本轮未完整完成；原会话文件折叠列表保留。

兼容性/边界：重启和关闭工具后仍可从 JSONL 记录恢复输出；旧成功 excel_patch_template 工具结果的结构化 details.file 可回溯关联，不迁移日志或解析正文。消息视图仅认可当前会话 manifest 中已登记的 outputs，下载继续校验 Cookie/会话归属及文件句柄。取消或失败前尚未发布的文件不生成卡片；已发布文件沿用手动删除和三十天过期联动，不因本轮失败自动撤销。提示只澄清该专用工具为额外窄写入例外，仍禁止通用写入/修改原件。

验证：构建及 66 项完整本地测试通过；稳定消息 ID 恢复调整后另跑 13 项附件/输出用例通过。新增覆盖多文件/真实后台 ID、正文无路径、虚构路径忽略、模型 401 后占位下载、output 事件早于完成及停止后保留、旧日志仅凭工具元数据恢复、关闭工具后恢复下载。隔离浏览器验证上传模板、实际 SDK 调用生成新 XLSX、回答下卡片、点击下载及刷新恢复；打开下载文件确认 B2=77，原件 B2=42。截图和日志在 `.data/debug/output-delivery-ui/`、`.data/debug/output-delivery-tests.log`、`.data/debug/output-delivery-web-tests.log`。本轮使用本地模拟模型，未调用真实供应商、未部署 VPS，未修改业务记忆/.env 或源 patrick-agent/pi-patrick。

## 2026-10-18 — 调试资料统一归档

原因：用户要求将开发调试资料集中到 `.data/debug/`，避免与正式运行数据混放。

行为/兼容性影响：将根目录测试日志、UI 截图与隔离测试服务目录、文件验证夹具/报告、Docker 测试配置及审查记录移入 `.data/debug/`，保留原目录名。历史记录中的证据路径同步修正为归档后的地址。后续调试资料统一放该目录；未修改应用代码、.env、知识/记忆、正式会话/附件、Python 运行环境或维护备份。已归档的一次性测试脚本/日志保留原内容，其中旧绝对路径仅作历史记录，不作为现行启动入口。

验证：所有迁移文件逐个校验 SHA-256、大小和权限（链接校验目标）一致；正式 agent/sessions/files、两套业务 Skill、共享记忆及维护备份前后摘要一致。迁移清单见 `.data/debug/2026-10-18-debug-relocation.json`。仅目录整理，无代码改动，未重新运行模型或测试套件。

## 2026-10-18 — VPS 原生文件处理与 systemd 部署

原因：用户明确选择不使用 Docker，VPS 为 Ubuntu24/x86_64、Node22.23.2/Python3.12.3、约1.6GiB内存，代码与两套知识目录已手工上传。

行为/兼容性影响：取消 Linux production 缺少 FILE_WORKER_IMAGE 时拒绝执行的分支；空镜像使用原有原生 Node worker，显式镜像保留容器行为。工作目录改为本任务目录；单并发、384MiB worker JS 堆、环境变量白名单、超时/取消终止进程组、原件/公式保护及输出登记保持不变。未新增 bash 或任意写入工具。这里原生 worker 不是每任务 OS 沙箱，不能声称仅能读取 job 或禁止联网。

部署：增加 deploy/product-expert.service，普通 productexpert 账号、主进程256MiB堆；systemd 整组 MemoryHigh900M/MemoryMax1100M/Swap256M、CPU150%、Tasks96，OOM 整组结束并由 on-failure 重启。服务只开放 .data 写入，知识目录和转换环境只读，保留额外记忆/会话/附件写入；.env 由 dotenv 读取。新增 docs/vps-native-deploy.md 说明凭据、账号、安装、Host兼容SSH隧道及更新流程；.env.example/README/文件工具文档同步。历史“Linux生产必须容器”的记录仅描述当时版本，以本条为后续修正。

验证：本机构建及67项完整测试通过；新增 production+空PATH+空镜像测试，实际创建Excel、验证输出内容、原件不变及公式拒绝，指标为process且没有容器峰值。测试日志在 .data/debug/vps-native-tests.log。另行 production 文件定向结果见 dev-history 记录。没有修改实际.env/知识/记忆，没有连接或改变VPS；未在Ubuntu24/systemd上执行本次unit，内存/只读mount/重启需用户VPS实测，不能把Mac子进程测试作为Linux隔离验收。未提交或推送。

## 2026-10-18 — Excel 空单元格写入修复与发布前校验

原因：VPS 真实模板在 F5:F33 填写及 F7 单格测试时，原工具把自闭合空单元格与后续单元格/行一起匹配，造成33行变5行/32行却仍返回成功。只读调查确认原表行号属性齐全，原附件SHA-256未变，模型“原表缺行号”的解释不成立。此前生成夹具没有覆盖行末带样式空单元格，本轮补齐。

行为/兼容性影响：用先识别开标签、区分自闭合/成对标签的扫描替换单元格及行匹配；安全处理已有空行、缺失单元格/行、空sheetData和单双引号属性。新增独立 worksheet 校验，在写入后与最终ZIP序列化后核对 XML、坐标顺序/行归属、既有行属性、未修改单元格原始内容、目标最终值、样式/元数据、工作表布局及dimension覆盖。无法安全解析的省略坐标等结构明确拒绝；校验抛错发生在发布/登记之前，不返回ok:true或下载卡片。沿用原件/公式保护和未改ZIP部件摘要验证；不改变其他工具/Skill/记忆/session逻辑。旧坏输出保留历史，不自动覆盖，应从原件重新生成。

部署说明纠正：补充知识检索必需的ripgrep和fd-find，避免Pi运行时下载等待。没有新增运行配置或依赖包。

验证：本机构建及75项完整测试通过（含8项新增回归），git diff --check通过；覆盖行末空白、连续29行/双sheet37格、清空重填、插入空行/缺失行/空sheetData、单双引号、公式邻接及值/样式/行/布局破坏拦截，实际worker拒绝不支持结构且无输出/登记。仅下载VPS原附件与原两次工具参数的只读副本到.data/debug/excel-patch-fix，重放37格与1格原操作后工作表均保留33行，原件摘要一致。日志与输出全部Git忽略。此次新代码未在VPS执行，未调用真实模型、未修改VPS文件或本机业务知识/.env/记忆，也未提交推送；源patrick-agent/pi-patrick未修改。

## 2026-10-18 — Office XML 编码与真实工作表名兼容

原因：用户上传 Spec EDC 070569.xlsx，所有文件工具在预检被笼统的 Invalid or unsafe Office XML 拒绝。只读检查确认48452字节、40个ZIP部件、非加密；主工作表XML可解析，5个customXml/item*.xml实际带UTF-16LE BOM，声明却部分为us-ascii/utf-8。此前data.toString(utf8)产生替换字符/NUL并被XMLValidator拒绝，不能据此归因为改后缀、密码、宏或外链。

行为/兼容性影响：新增decodeOfficeXml，按BOM/字节签名选择UTF-8/UTF-16LE/UTF-16BE，fatal解码拒绝坏字节，明确不支持UTF-32。先解码再执行原XML验证与DOCTYPE/ENTITY拒绝，ZIP/扩展体积/像素/单元格限制保持不变；错误提供部件名和编码或XML错误位置。既有ZIP与元数据字节不改写。另修复写入端先trim工作表名的问题，精确匹配实际的“Spec EDC ”，找不到时再保留旧trim回退。不修改其他Agent/记忆/会话逻辑，没有新增依赖或.env字段。

验证：本机构建和79项完整测试通过，新增4项编码回归覆盖BOM与无BOM签名、双字节序、损坏字节/UTF-32拒绝、UTF-16中的DTD/实体拒绝、体积限制、真实worker读取/写入且元数据和原件保留。用户真实附件按workbook及worksheet读取均complete，测试副本C5写入成功，重新打开确认值，15个customXml部件字节完全一致、原文件SHA-256未变。日志/测试输出仅存.data/debug/office-xml-encoding/且Git忽略。没有修改用户附件、业务知识/.env/记忆或VPS，也没有调用真实模型或部署；未提交推送。

## 2026-10-18 — Office XML 测试 npm 快捷命令

原因：用户希望无需记忆环境变量和测试文件路径，直接使用 npm 命令。

行为/兼容性影响：增加 npm run test:office-xml，先构建再以 NODE_ENV=production、FILE_WORKER_IMAGE为空执行 Office XML 编码回归；沿用项目Mac/Ubuntu shell，不引入cross-env依赖、不改.env和服务配置。npm test/npm run test仍执行完整套件。README与VPS部署文档同步。

验证：直接执行 npm run test:office-xml，构建及4项测试通过；日志在.data/debug/office-xml-encoding/npm-test.log。仅新增命令，无Agent运行行为变更，未修改业务数据或VPS，未提交推送。

## 2026-10-18 — 本地产品文档与专属记忆同步脚本

原因：用户要求在ProductExpertCloud/.data创建product_docs_sync，从只读patrick-agent来源同步产品Markdown，产品MEMORY改从skill_memories专属路径获取。

行为/兼容性影响：创建.data/product_docs_sync.py（按用户要求位于Git忽略目录），仅用Python标准库。递归保留相对路径，同步.md（大小写均可），排除任意层级名为SYNC_PROMPT.md/SKILL.md/MEMORY.md的源技能Markdown；单独将patrick-agent/skill_memories/urovo-product-expert/MEMORY.md同步为目标根MEMORY.md。默认新增/更新、不删除目标独有文件，不碰共享memory/UMS；提供--dry-run和路径覆盖参数。实际写入逐文件临时文件+fsync+replace，覆盖前备份至.data/maintenance-backups/product-docs-sync/，同进程外flock拒绝并发脚本，源/目标重叠、链接及空源MEMORY拒绝。脚本只负责本地同步，不修改/运行源项目，不会通过Git自动传到VPS。

验证：隔离临时夹具验证预览零写入、深层排除、只复制MD、专属记忆来源、源项目内容不变、共享记忆不变、目标独有文件保留、备份、重复运行幂等和链接拒绝。真实目录只运行--dry-run：0新增、1更新（MEMORY.md）、491相同、3排除；没有实际修改业务知识或记忆。日志统一.data/debug/product-docs-sync/{tests.log,preview.log}。本轮没有运行主项目或源项目测试，没有部署/提交推送。

## 2026-10-18 — 单文件上限提升至30MiB

原因：用户要求最大文件上传从10M调整到30M。

行为/兼容性影响：FILE_MAX_BYTES默认由10485760改为31457280，.env.example同步；Web既有后端/前端校验及提示动态读取该值，无需硬编码界面文案。Excel读取/模板输入输出及图片原件输入改用worker配置，移除内部20MiB/12MiB输入硬上限，避免30MiB上传后被旧限制拒绝。继续保留Office64MiB展开、50000单元格、2000万像素、文本/视觉请求大小、100MiB会话配额和执行超时/队列等限制。现有.env显式数值仍优先，VPS须单独调整.env再重启；本机.env没有显式该字段，因此未修改它。

验证：本机构建和81项完整测试通过；新增HTTP30MiB边界成功、30MiB+1返回413、流式超限拒绝且无残留登记；状态接口返回31457280，前端使用此值。真实worker读取并修改含21MiB原始ZIP部件的XLSX、读取13MiB合法PNG均成功，证明旧内层限制已解除。日志在.data/debug/upload-limit/full-tests.log。未调用真实模型、修改知识/记忆、修改VPS或提交推送。

## 2026-10-18 — Web 登录有效期延长至7天

原因：用户要求把原12小时登录状态改为7天。

行为/兼容性影响：SESSION_MS改为7×24小时，浏览器Cookie Max-Age=604800秒、服务端内存令牌过期统一由同一常量计算。为登录时起算的固定有效期，普通访问不续期；保留HttpOnly/SameSite、退出注销、限流及128会话上限。登录记录仍仅在内存，重启或dispose继续使登录失效，不新增凭据或登录持久化。.env无需修改，更新重启后重新登录获得新有效期。README同步。

验证：构建及33项认证/Web定向测试通过，模拟时间验证12小时仍有效、7天前1ms有效、满7天失效，并校验Cookie=604800和HTTP登录/注销/限流/重启行为。日志.data/debug/login-seven-days/tests.log。没有真实模型、业务数据或VPS操作，未提交推送；同工作区既有30MiB上传改动保留。

## 2026-10-18 — 企业微信长连接 Bridge 与 HTTP 共用并发限制

原因：用户要求将 VPS 的 Product Agent 接入企业微信，支持多人同时问答、读取 PDF/Word/PPT/Excel 和图片、填写标书并回传文件；单聊按用户隔离、群聊全群共享，日常由主服务统一启停。

行为：新增独立 `integrations/wecom-bridge/`，使用精确版本 `@wecom/aibot-node-sdk@1.0.7` 的 Bot ID/Secret 长连接认证、重连和媒体上传，官方 SDK 解密配合有界下载。支持单/多机器人命名空间；单聊每用户、群聊每群复用 session，按会话顺序调度。先上传后提问时，将三十分钟内的待处理附件与该上传者下一条明确问题绑定；多份文件要求指明名称或全部。文件工具及技能/记忆均复用现有后端，不给企微增加 Bash 或任意文件写入权限。发送“新建对话”或 `/new` 重置当前映射，群里作用于整个群。

接口/配置：增加受 `WECOM_API_TOKEN` 保护的本机 `/api/wecom/status` 及有限 session/run/stop/files/rename/delete 接口；与浏览器 Cookie/CSRF 分离，校验 Host/Origin，仅允许操作后端登记的企微会话，不能访问 Web 专属会话或 Agent 设置。原浏览器认证保持不变。Web 和企微 HTTP run 共用默认 2 个运行、8 个等待的 Gate，可配置 `AGENT_MAX_CONCURRENT_RUNS` / `AGENT_RUN_QUEUE_LIMIT`；取消等待不调用模型，队列满返回 429，同会话仍拒绝重入。原库/CLI 调用不受 HTTP Gate 限制。计时从取得运行名额开始，不包含此前排队时间。

文件/持久化：PDF/DOCX/PPTX/XLSX/图片走现有受控文件目录与工具；单文件遵循 FILE_MAX_BYTES 且企微侧最多30MiB、单条20个/合计60MiB，批次下载全局串行，暂存到 `.data/wecom/inbox/`。输出直接消费 SSE `output` 及本轮结构化记录，无需模型提及文件名或 fileId；长回答按 UTF-8 字节拆分，回调回复失效时尝试主动投递。映射、去重、任务和投递进度以原子 JSON 保存于 `.data/wecom/`，完成后移除桥接正文/暂存件；后端会话附件继续按手动删除/闲置30天清理。完成去重记录最多七天/一万条，活动任务不截断。重启恢复排队与投递；未知运行先查原 run/产物，不重复执行可能有副作用的请求。消息投递不承诺崩溃窗口下严格 exactly-once，平台离线消息补发与权限需真实验收。

部署/兼容性：`WECOM_ENABLED=false` 为默认，不需要企微凭据即可继续运行 Web；缺省 API 凭据不开放 machine 接口。新增 `product-expert-wecom.service`（按用户当前 root 部署选择），主 unit 的 Wants 与桥接 unit 的 PartOf/After 关联启动/停止/重启；需首次复制两个 unit、创建 `.data/wecom` 并 daemon-reload。Bridge 单独限制192MiB Node heap / 300MiB总内存，主服务原上限不变。未修改本机 `.env`、技能、业务记忆或参考 patrick-agent；密钥、运行数据和日志继续 Git 忽略。详细配置和 VPS 步骤见 `docs/wecom-bridge.md`。

验证：本机构建及完整回归100/100通过（含19项新增企微相关测试）；新增本机模拟企微/模型测试验证身份隔离、群共享、跨会话并发/同会话串行、HTTP 权限/重启归属、Web 与企微共用队列、等待停止、附件绑定、超量拒绝、加密文件解密/有界下载、UTF-8/SSE、消息去重、暂存/投递恢复与无副作用重跑。端到端通过真实 Agent SDK 和文件子进程读取 PDF/DOCX/PPTX、读取并填写真实 XLSX，再校验回传文件的目标值、样式、公式及原件未改；模型最终文字未包含文件名仍能回传。没有连接真实企微、调用真实供应商模型或在 VPS 安装/运行 unit，未宣称 Ubuntu 实测或真实投递已验收。

验证补充：最终 `npm test` 100/100 通过，约15.3秒；`WECOM_ENABLED=false npm run wecom:bridge` 冒烟正常退出，最终 diff 检查通过。Linux 锁恢复使用 boot ID/进程开始时间识别 PID 复用；该分支留有 Linux 条件测试，但本机 macOS 不算作 Linux 实测。

## 2026-10-18 — 修正为 Agent 与企微 Bridge 独立启停

原因：用户明确改为分别管理 product-expert 与 wecom-bridge，不再沿用上一条历史记录中的主服务联动方案。

行为/兼容性：Bridge unit 更名为 `deploy/wecom-bridge.service`，移除其 Requires/PartOf 主服务依赖，主 unit 移除对 Bridge 的 Wants。保留 After 仅用于同时启动时排序，Bridge 增加自己的 WantedBy=multi-user.target，可独立 enable/start/stop/restart。停止任一服务不会通过 systemd 启停另一个；Agent 不运行时 Bridge 无法调用其问答 API。WECOM_API_TOKEN 仍用于独立于 Web Cookie 的本机 API 鉴权，未取消或复用企微 Secret。README 和企微部署说明同步改为独立管理，并说明旧 unit 的迁移。

验证：本轮只涉及 unit 文件名/依赖与文档，检查 unit 内容、配置引用和 git diff 格式通过；未重复执行之前已通过的100项问答/文件测试，未在 VPS 实际安装或运行 systemd。此前历史记录保留，以上修正为当前最终行为。

## 2026-10-19 — HTTPS 域名反代登录来源修复

原因：用户通过 https://urovo-agent.patrick-shenzhen.cn/login 访问，原代码将所有 Origin 固定与 http://Host 比较，TLS 在代理端终止且 Host 改写时，页面可打开而登录 POST 返回“不允许跨站请求”。

行为/兼容性：新增 WEB_PUBLIC_URL（WebOptions.publicUrl）作为单个显式 HTTPS 来源；只接受根来源，不接受 /login、通配符、账号密码、查询或片段。未配置时维持原本本机 Host/HTTP 来源约束。配置后兼容代理保留公开 Host 与改写为本机 Host 两种模式；不从 X-Forwarded-* 自动授予信任，陌生 Host/Origin、null Origin、cross-site 仍拒绝。管理员认证、修改请求 X-Local-Token 与七天有效期不变；识别为公开HTTPS请求时登录/注销设置 Secure，仍保留 HttpOnly/SameSite=Strict，本机HTTP登录不强制 Secure。企微 machine 路由不接受公开 Host/Origin，反代示例明确不转发 /api/wecom/。监听仍只在127.0.0.1，不引入公网监听或无鉴权API。

配置/部署：.env.example 新增空白 WEB_PUBLIC_URL，README 与 VPS 文档增加域名、反代 SSE/30MiB上传及独立 Agent 重启步骤。VPS 须设置 WEB_PUBLIC_URL=https://urovo-agent.patrick-shenzhen.cn 并更新代码后重启 product-expert.service。无需修改企微 Secret/Token 或联动重启 Bridge；未修改本机.env、VPS、业务知识与记忆。

验证：新增四项 HTTP 回归覆盖保留/改写 Host 登录、Secure Cookie/退出、未登录拒绝、CSRF、陌生/伪装来源及转发头不扩大信任、默认本机行为、machine入口、本地.env读取与非法配置。定向八项测试已通过；完整回归结果见后续验证补充。模拟的是 TLS 在代理终止后的后端 HTTP 请求，未声称已配置或登录真实公网域名。

验证补充：最终 `npm test` 104/104 通过，约18.6秒；git diff 检查通过。日志统一 `.data/debug/web-public-origin/`。没有修改真实反代配置或 VPS，仍需用户同步本次代码、设置公开来源并重启 Agent 后验收。

## 2026-10-19 — 企微联系人备注与用户消息通知

原因：用户授权将其他人的私聊/群@消息推送给自己，排除自己；后续明确改为在 Web 管理所有已见 User ID 的备注，推送显示“对话人”备注，不再显示 session 的“会话”字段。

行为：Web 左侧增加“企微联系人”，可查看/搜索 Bot ID + User ID、私聊/群聊出现位置及最近出现时间，保存或留空清除备注。现有 bridge-state 的单聊映射及保留的群消息发送者会导入，之后接收新消息自动登记。私聊/群聊同一发送者共用备注，不同机器人区分身份；备注独立于对话重命名、删除与30天会话清理，不修改模型上下文或 Agent session。

接口/持久化：新增管理员 GET /api/wecom-contacts、PATCH /api/wecom-contacts/:id（现有Cookie与CSRF）；Bridge只可使用专用凭据POST /api/wecom/contacts登记身份并读取最新备注，未知字段及通过登记改备注均拒绝。后端独占写 .data/wecom/contacts.json，串行修改/原子保存/权限600并拒绝符号链接，避免 Bridge 和 Web 写同一个数据文件。不增加依赖，不开放额外监听端口。

通知：新增 WECOM_NOTIFY_USER_ID，既作主动接收人也作发件人排除条件；多Bot项支持 notifyUserId 覆盖/空值关闭。默认不转发，仍登记联系人。通知只含用户消息、身份、北京时间及附件名称/类型，不含助手回复、工具体或文件字节，不调用模型。新消息去重后独立入队，问答队列满或不支持的消息也尝试通知；不回放此前历史消息。附件最多等5秒取名称，之后可先显示类型。长文本按UTF8字节分段，单独退避重试和保存确认进度，不占用 Agent 执行名额；备注在首次投递前/未发送成功的重试时读取，群成员按各自User ID备注。接收人变化不把旧待发消息交给新接收人。

恢复/边界：Bridge独占 .data/wecom/message-events.json，最多500待处理，完成正文删除，完成去重记录7天/1万条，待发超过30天清理正文；队列/磁盘或通知故障不阻断问答。通知确认与落盘之间仍有崩溃窗口，不承诺strict exactly-once；真实主动推送权限需企微验收。未修改实际.env、业务记忆/技能、VPS、参考patrick-agent或pi-patrick。首次升级需分别重启Web/Agent与Bridge加载接口/页面和队列，后续只改备注无需重启。

验证：新增8项回归覆盖备注导入/同人群私共用/跨Bot隔离/并发保存与文件边界、HTTP鉴权与不可越权改备注、自己排除/去重/重启、重试最新备注/接收人变化、长文本部分投递恢复、北京时间、通知慢不阻塞正常run。已有真实文件端到端测试同时启用真实联系人API和模拟企微通知，验证PDF/DOCX/PPTX/XLSX读写与备注通知同时工作。浏览器隔离测试验证左侧入口、列表、备注保存、刷新恢复与搜索，截图 .data/debug/wecom/contacts-ui.png；使用虚构身份/本地模拟传输，未向真实用户推送。最终完整回归结果见验证补充。

验证补充：最终 `npm test` 112/112通过（含27项企微相关），约16.1秒；前端语法与diff检查通过。真实文件E2E同时验证四次使用备注名的通知及Excel回传。隔离浏览器保存/刷新/搜索成功，测试tab和独立60903服务均已关闭。未向实际企微账号发送通知或部署VPS。


## 2026-10-19 — 联系人独立页面与提问 / Token 累计

原因：用户要求联系人改成新页面，增加提问次数与 Token 消耗，保留原有备注和通知规则。

行为：左侧入口导航到 /wecom-contacts，不再使用对话框；页面独立加载，不初始化聊天运行时，支持返回工作空间、搜索、刷新、修改/清除备注、汇总和逐人统计。提问次数为实际接受并开始的 Agent run，失败/停止也算一轮；文件单独上传、新建对话指令、被队列拒绝的消息不计入。按 Bot ID + User ID 累计，同人的群聊与私聊合并；群共享上下文仍归本轮发送者，Web 自身提问不归企微联系人。

统计口径：Bridge 向 run API 附带经验证的 wecomSender，Web 请求不能伪造此字段；旧 Bridge 不传身份仍兼容问答，但不记联系人统计。后端记录每次 payload / assistant message_end，累计工具循环产生的全部模型请求。SDK 输入加回 cacheRead/cacheWrite，输出不重复加 reasoning；文件工具结果中观察到的专用视觉请求 usage 同样累计，进程内缓存命中不重复计费统计。只使用收到的 usage，不按文本长度估算；SDK 全零 usage 无法区分未返回，保守显示未记录。失败/停止/中断时未收到 usage 的请求及未返回结果的视觉调用可能缺失，因此用于调试，不作为账单对账。

持久化/兼容性：在现有 .data/wecom/contacts.json 中增加可选 stats 和每 session 最新 sequence/runId/usage 游标，原文件与备注可直接读取；逐 run 快照同时存入原 JSONL custom entry，不注入模型。原子串行更新，旧/重复快照不会二次累计，重开 session 按日志快照补齐尚未落盘的增量，整段恢复仅读写联系人文件一次，避免长对话逐轮重复落盘。累计值与游标不随手动删除、30天过期清理而删除；不复制消息正文或新增数据库依赖。统计只从升级后开始，不强行回填历史归属；页面显示起始时间、已结束轮次和收到 usage 的请求比例。中途统计写盘失败记录日志，不中断已经执行的回答；16MiB 联系人与游标文件限制保持，超过或损坏不静默覆盖。升级需同步代码并分别重启 Agent 与 Bridge，无新增环境字段。

验证：新增4项回归，覆盖真实本机模拟模型的工具两轮 usage、缓存/思考口径、群中两人归属、并行、停止缺失 usage、重启快照去重、session 删除后累计保留、未知字段/网页伪造身份拒绝及独立页面鉴权。既有 PDF/DOCX/PPTX/XLSX 真实文件 E2E 加入 Bridge 发送者统计断言。完整并行回归发现既有投递恢复测试固定等待100ms会早于写盘/失败处理完成，改为等待 Bridge idle 后再重启，未改变生产投递行为。隔离浏览器验证首页入口导航到独立页面、备注保存、刷新和搜索；截图 .data/debug/wecom/contacts-page.png 使用虚构身份及统计。未调用真实模型/企微、未修改实际 .env、业务知识或 VPS。

验证补充：定向企微31/31通过；完整 npm test 116/116通过，约14.1秒（最后一处 SSE 响应头位置调整后的验证结果见后续补充）。浏览器测试tab和50646隔离服务已关闭；日志统一 .data/debug/wecom/contact-stats-*.log。

最终验证补充：SSE响应头顺序及整段恢复单次写入优化后，`npm test` 再次116/116通过（约14.3秒）。前端/Bridge语法与git diff检查通过。当前仅本地代码完成，未提交/推送或部署。


## 2026-10-19 — 资料库文件与工具链接检索

原因：用户要求新增 get_file_link_from_library，将用户 prompt 原封不动发送给指定 POST https://tool-files.patrick-shenzhen.org/api/ai-search，获取文件/软件下载链接。

实现/行为：Core 默认新增一个自定义 HTTP 工具，模型参数为单个 prompt。运行中的实际请求正文绑定当前 session 最新用户消息的原始文本，忽略模型改写值；不会拼入技能、记忆、历史或附件说明。每个 session 分别绑定，避免多人并行串用提示词。Web 保留非空正文的前后空白及换行传给 Core；标题/空白校验/默认附件提示仍沿用原逻辑。JSONL 工具结果包含实际发出的 prompt 与上游完整 JSON，参数/耗时/数量沿用既有工具追踪，不新增持久化或文件下载。上游内部消耗没有 usage 时不计入主 Agent 模型 Token。

默认启用/兼容性：基础工具由5个增至6个，六个文件工具全开时12个；不归文件工具总开关控制。Web、企微、本地 Core 新建及恢复 session 均可用；不新增 endpoint 配置、鉴权字段或软件依赖。固定 HTTPS 目的地、只 POST prompt、禁止跟随重定向、60秒超时、取消联动、正文256KiB限制；HTTP错误/格式错误/无网络/超时明确失败，无工具层自动重试。没有匹配保留为空结果，不伪造或自动访问返回文件。提示词明确用户求文件/工具链接时调用并展示真实URL，外部检索描述不作指令，不违反普通问答默认不带来源的偏好。

验证：真实接口使用用户提供的“我要 DT50S 的规格书”示例请求获得 HTTP200、outcome/message/matches（含文件URL），原始结果仅放 .data/debug/library-link/api-sample.json。新增5项本机回归覆盖原文保留/模型改写不能替换、固定目的地、无匹配、不可用原文、HTTP错误/JSON错误/有界流读取、超时/停止、Core并行会话隔离/恢复/Web与企微入口复用/关闭文件模块仍注册/调用留痕，专项5/5通过；原有工具名单断言同步增加新工具。真实接口连通性验证与本机模拟模型测试分别说明；未调用真实 Agent 大模型验收，不声称模型一定选择工具或上游推荐内容事实正确。未修改实际.env、业务资料/记忆、参考项目或 VPS，未提交或推送。完整回归结果后补。


资料库链接工具验证补充：上次开发在中断前已完成完整 `npm test` 121/121通过（约14.4秒），日志 `.data/debug/library-link/full-tests.log`；上述“完整回归结果后补”在此补齐。本机模拟模型与真实接口连通验证口径不变。

## 2026-10-19 — 资料库链接工具独立开关

原因：用户要求继续上次开发，将默认启用的 get_file_link_from_library 做成与文件工具同样可在 Agent 设置中自由开关。

行为/兼容性：Agent 设置新增“资料库链接”独立开关，默认开启，与六个文件工具及文件总开关互不影响。复用受管理员鉴权/CSRF/Host/Origin保护的 GET/PUT /api/agent-settings，在现有 .data/web-agent-settings.json 中保存 libraryLinks.enabled；旧持久化设置和旧请求缺少该字段时按先前行为开启，非法类型/未知嵌套字段拒绝。保存时沿用执行中返回409的保护，释放缓存会话与运行时后，Web和企微下次请求统一采用新设置，重启仍保留；既有JSONL历史与附件不删除。Core增加 libraryLinksEnabled 布尔配置，默认true；关闭时同时移除名称、自定义工具注册和专用提示词，模型沿用历史或伪造调用也不会执行HTTP。基础工具关闭链接后五个、开启六个，文件模块另加最多六个。未新增 .env 配置、依赖或外部请求。

验证：本机模拟模型覆盖Web/企微入口、已有/新建/重启恢复session、文件工具开而链接关/文件工具关而链接开、关闭时伪造调用不发HTTP、重新开启恢复原文请求；持久化回归覆盖旧文件兼容、关闭值保留、mode600及接口非法字段。隔离浏览器验证默认开启、关闭保存、刷新后仍关闭，截图 .data/debug/library-link/settings-toggle.png；使用空模型配置，未调用真实模型或真实资料库。未改实际 .env、业务知识、原有用户设置或VPS；代码未提交/推送。

最终验证补充：`npm test` 122/122通过（约25.6秒），包含构建、真实格式文件worker、既有企微问答/回传/联系人统计及新增开关回归；`node --check resources/web/app.js` 与 `git diff --check` 通过。日志 `.data/debug/library-link/toggle-full-tests.log`。隔离浏览器页和49947测试服务均已关闭，未触碰正式4321服务。


## 2026-10-19 — 按需联网 search / fetch 与独立开关

原因：用户要求新增DeepSeek Search/Fetch两个工具，复用DS密钥，工具说明强调“需要联网时才联网”，并要求像其他工具一样自由启停。

行为：新增 src/web-tools，search固定POST /v1/tools/search，参数query（1～128个Unicode字符）与可选count（默认5、限制1～10），固定need_content=false，返回有界标题/公开URL/摘要。fetch固定POST /v1/tools/fetch，只传url，返回标题/Markdown正文（最多60000字符并标记截断），不自动下载、注册文件或保证PDF可提取；拒绝带凭据、IP字面量、本机及明显内网域名，真实目标解析/抓取交由DeepSeek上游安全策略。返回HTTP错误、无正文、格式错误与空搜索结果各自处理，不把外部描述视作指令。

配置/兼容性：Web Agent设置新增联网总开关与search/fetch独立开关，初始总开关关闭、两项偏好为true；默认工具集合保持原样。偏好复用.data/web-agent-settings.json的webTools.enabled/tools，旧文件/旧请求缺少字段时默认关闭；严格拒绝未知字段、错误类型与伪造密钥。沿用管理员/CSRF/Host/Origin校验及运行中409保护。保存后销毁缓存运行时/会话，Web/企微下次请求重建并应用，重启恢复也生效；关闭同时移除工具注册和专用调用指导。历史JSONL、记忆、文件处理及资料库链接开关保留。两个联网工具全部启用最多加2个，全开最多14个。

密钥/资源：直接HTTPS api.deepseek.com主模型复用API_KEY；其他供应商或代理不自动转用其密钥，可选DEEPSEEK_API_KEY（或Core webTools.apiKey），.env.example增加说明，页面只显示是否配置，密钥不传给模型、不写设置/调用参数；受控结果同样替换已知密钥。未配置有效来源时启用返回400。每个接口进程共享5次/秒滑动窗口、等待队列32个，跨session/runtime重建仍共享；不协调进程外同账户流量。排队+HTTP共用60秒超时/用户取消，响应最多1MiB、有界流读取，禁止重定向，不自动重试。无新增依赖，适用于现有Ubuntu/Node部署。按次API成本不记录为模型Token；工具输出进入模型后的usage照常统计。

提示词：工具description、promptGuidelines及启用时系统指导明确“用户要求联网、最新事实核实、本地资料不足或阅读用户URL时才用；资料足够直接答，摘要足够无需fetch；不发送内部文档、记忆、凭据或完整历史”。联网选择为软约束，不宣称可保证模型绝不多查；关闭注册为程序约束。普通问答默认不附来源的现有偏好保持，资料库链接工具职责不变。

验证：新增7项联网测试覆盖DS密钥复用/隔离、固定目的地与原始schema、Unicode长度/非法参数/公开URL限制、空结果/截断/敏感值替换、HTTP错误/格式错误/响应上限、超时取消/有界队列，以及真实本机SDK+模拟模型的Web/企微并发调用、两个独立开关/总开关、新建及重启恢复session、关闭时伪造调用无HTTP、调用记录/耗时与密钥不落盘、缺密钥拒绝保存；原设置测试增加schema/旧配置兼容。`npm test` 129/129通过（约28秒），日志.data/debug/web-tools/full-tests.log；定向7/7通过。增加npm run test:web-tools便利命令。隔离浏览器验证总开关初始关闭、保存仅search开启/fetch关闭、刷新保持，截图.data/debug/web-tools/settings.png。使用虚构密钥/本地模拟模型与上游，未调用真实DS/真实Agent模型或企微推送，不宣称真实PDF或模型联网选择已验收。未改实际.env、业务知识、用户设置、参考项目或VPS，未提交/推送。

验证补充：`npm run test:web-tools` 实际执行7/7通过（约3.8秒），前端语法和diff检查通过。隔离浏览器测试页及55583服务已关闭，未启停正式服务。


## 2026-10-19 — 全英文Web与仅单项工具开关

原因：用户要求Web界面全英文，设置不保留任何总开关，每项工具分别控制。

界面：登录页、主工作空间、联系人页、设置、会话管理、附件/输出卡片、工具详情、调试面板、运行提示、固定错误文案及无障碍标签全部改为英文，日期/数值使用en-US。示例问题同步为英文；用户输入、历史会话名称、联系人备注、附件名和模型/工具返回内容作为数据保留原文，不翻译业务知识或修改回答语言策略。登录页原“12小时”提示纠正为实际7天，认证有效期和权限不变。HTTP基础错误改用英文，企微共享API的对应错误提示也随之英文；企微Bridge推送模板未改。

设置/兼容性：移除联网与文件两个总开关及其前端禁用联动，九项可选工具均独立选择（search、fetch、资料库链接、六个文件工具）。GET/保存使用fileTools:{tools}、webTools:{tools}，不再包含分组enabled；libraryLinks.enabled仍为该单项开关。服务端根据实际选中项推导内部模块enabled，并按所选工具注册，Core/CLI原模块配置保持；执行中修改仍返回409，Web/企微后续请求和重启恢复共用。旧持久化/旧客户端可传分组enabled，false迁移为该组全false，true保留单项值；默认不误启用原来被总开关屏蔽的工具。仅加载时不重写旧文件，下一次保存写出规范格式。缺少联网组仍默认search/fetch均false；未保存的文件初始值沿用FILE_TOOLS_ENABLED。设置、会话日志、附件及联系人等现有数据不另建存储。

验证：新增两项回归覆盖旧总关/总开/混合项迁移、新接口无enabled字段、只开PDF即可启用模块/注册SDK工具、原子保存/重启持久化，以及所有Web页面/脚本/固定标签全英文、无总开关元素、登录提示7天与错误提示；已有联网/资料库及文件测试改为逐项选择并继续覆盖新建/恢复/并发与旧设置兼容。完整`npm test` 131/131通过（约15.4秒），日志.data/debug/english-ui/full-tests.log；语法与diff检查通过。末尾仅英文单复数/头像文案调整另做浏览器确认，未改运行流程。

浏览器：使用隔离虚构账号、模拟模型/密钥与联系人，验证英文登录、仅勾选search/PDF直接保存、刷新恢复、中文问答仍原样显示、英文工具操作/调试面板、联系人备注保存；证据统一.data/debug/english-ui。未调用真实模型/DS联网或企微推送，未改实际.env、原有业务数据/知识/用户设置、参考项目或VPS；未提交/推送。

验证补充：最终英文文案调整后，单项开关/全英文页面定向回归2/2通过，三份前端脚本语法与git diff检查通过。浏览器刷新确认search/PDF选中、其余文件与fetch关闭，各开关均可直接操作；联系人改名刷新保持。截图login.png、contacts.png、settings.png位于.data/debug/english-ui。隔离测试页和59032服务已关闭，正式服务未启停。


## 2026-10-19 — 匿名文本MCP与持久Token统计

原因：用户要求将产品专家作为只接受文本的MCP提供，无需鉴权，并做好Token统计。

接口：现有Web/Agent进程新增可选/mcp，MCP_ENABLED默认false，开启后不要求Cookie/Bearer/CSRF；Host/Origin仍沿用显式公开地址及本机检查，其他Web/企微接口鉴权不变。使用官方MCP server/node SDK固定版本和zod，新增开发依赖官方client验证；无额外监听端口/服务。三个普通工具ask_product_expert、get_task_result、cancel_task，快答直接返回文字，默认10秒未完成返回随机任务/会话句柄，查询建议间隔2秒；不是标准Tasks扩展。question仅文本/最多12000字符，可选request_id UUID幂等重试，避免断线重发再次计费；不同问题复用同ID拒绝。HTTP断开不取消后台任务，显式取消/15分钟期限/关停联动，重启未完成不自动重放。

Core边界：增加textOnly会话profile，保留现有必需技能/记忆每run注入、普通UMS按需与五轮窗口；MCP无memory和六文件工具注册/执行，读取限制在知识库/技能目录，不能读.env/其他session，Web文件开关不改变MCP权限。资料库链接/search/fetch沿用全局单项设置。新旧MCP会话可经store或JSONL标记恢复profile，关闭MCP入口后管理员恢复旧会话也不放大权限。共享Web/企微并发gate和有界队列，同conversation只允许一个待完成任务；MCP待处理默认10/总保留5000有界，执行后释放SDK会话内存以适配小VPS。

统计/持久化：逐模型payload记录请求次数，assistant message_end累计SDK input+cacheRead+cacheWrite、output（含reasoning不重加），工具循环每次请求均计。查询/取消不计新模型用量；上游资料库内部Token、按次联网费用、调用方模型不计。usage覆盖明确not_started/unavailable/partial/complete，不以文本估算或把未知宣称零消耗。JSONL保留run快照，.data/mcp/state.json串行原子存task与累计增量，answers分文件有界保存；重启从JSONL补齐且去重，回答先落盘再发布完成状态，避免已完成却无正文的窗口。启动按session分组仅读紧凑metrics，不缓存全部SDK历史。任务/回答30天、会话最后活动30天保留，手动删除同步清理句柄/回答，累计计数保留；孤立回答清理覆盖删除落盘后的崩溃窗口。单服务进程独占目录，不宣称分布式多实例或供应商账单准确性。

管理界面：左侧新增MCP usage独立英文页和管理员GET /api/mcp/usage，显示累计提交数/输入/输出/总Token/usage覆盖/最近50项任务；接口另给会话统计。不向匿名MCP提供任务列表，不复制prompt/answer到统计页面。无鉴权只能按匿名conversation/task统计，无法验证真实个人归属。.env.example/README/docs/mcp.md给出开关、客户端URL、VPS npm ci和重启步骤；npm run test:mcp为专项入口。

验证：本机官方MCP客户端+真实Core SDK+模拟模型，新增11项覆盖快答/异步/断开重连/纯文本schema、工具循环缓存与思考Token、幂等与重启增量、取消缺失usage、Web共享排队、超时/容量、不可写记忆/文件及不可读配置、手动删除/30天清理、损坏数据/符号链接、Host/Origin/64KiB限制与2025协议兼容。首轮完整npm test 142/142通过（约15.1秒）；最终收尾及浏览器验证后补。本机模拟验证不等于真实模型、生产域名或VPS部署验收。未修改实际.env/业务知识/用户记忆/设置，未向企微推送，未修改参考patrick-agent/pi-patrick，未提交/推送/部署。

最终验证补充：收尾修正恢复时不回退已记录usage、无本轮助手消息时不复用上一轮答案、释放MCP会话内存，并补充孤立回答清理回归。`npm run test:mcp` 11/11通过；最终完整`npm test` 142/142通过（约14.6秒），日志`.data/debug/mcp/final-full-tests.log`。新增MCP页面/脚本加入全英文检查，前端语法与git diff检查通过。浏览器使用隔离虚构账号、模拟模型完成首页入口→MCP usage独立页→刷新，核对输入1240/输出180/总1420及1/1请求覆盖，截图`.data/debug/mcp/usage-page.png`；测试tab与51082隔离服务均已关闭。未连接生产域名或真实模型，未部署VPS。


## 2026-10-19 — MCP独立Bearer Key

原因：用户要求在.env配置Authorization Key，取代此前匿名MCP访问；已确认采用Authorization: Bearer。

行为/兼容性：新增MCP_API_KEY（.env/进程环境，库调用可用mcp.apiKey覆盖），/mcp所有HTTP方法在创建SDK传输前要求正确Bearer头，缺失、错误或Key为空返回401及WWW-Authenticate，不启动任务/模型、不增加Token。Host/Origin校验保留。空Key不导致整个Web启动失败，而是关闭MCP访问；Key格式仅允许无空格可见ASCII，不在错误中回显值。Key更换需重启；旧客户端必须加头，URL/query/Cookie或Web/企微凭据不能替代。原Web登录/CSRF、WeCom认证及任务/会话持久化沿用；现有共享Key不提供个人身份/多租户隔离。

实现：独立McpAccess预计算SHA256并定长timingSafeEqual；Key不传给模型、工具或任务元数据，加入统一错误敏感值替换。管理统计API只返回authentication=bearer和keyConfigured布尔；英文usage页面同步显示认证状态，文档与.env.example更新，原Token统计口径和幂等/取消逻辑不变。未新增依赖、未生成或修改实际.env的密钥。

验证：专项回归首轮13/13通过，包括官方SDK客户端携带头完成问答/轮询/取消，新增未授权各种方法/三工具拒绝及零模型和统计、query不能替代、Web认证不可混用、重启轮换后旧Key拒绝/历史结果与Token保留、空Key拒绝但管理员可用、密钥不进入模型payload/管理统计，以及隔离.env读取与格式校验。最终完整回归结果后补。本机模拟模型验证，不代表VPS/真实客户端已部署验收；开发目录ProductExpertCloud，未触碰参考项目/业务知识记忆或VPS。

最终验证补充：包含隔离.env真实读取、全部未授权工具路径和Key轮换的最终完整`npm test` 144/144通过（约26.5秒），日志`.data/debug/mcp/auth-full-tests.log`；前端脚本语法与git diff检查通过。未使用真实模型/生产密钥，未修改实际.env或部署VPS。


## 2026-10-19 — MCP整合Settings与通知备注刷新

原因：用户要求MCP合并到Settings，仅显示提交数/输入/输出/总Token和可自由启停；企微后台有姓名时通知直接显示姓名。

界面/接口：移除MCP侧栏独立入口和旧静态页面/脚本，Agent Settings增加MCP区四项累计（Submitted Task、Input Tokens、Output Tokens、Total recorded tokens）和即时保存switch。旧/mcp-usage重定向/?settings=mcp并自动打开Settings。新增管理员GET/PUT /api/mcp/settings；GET仅读紧凑累计，不构建任务/会话列表，PUT仅接受enabled布尔，原Cookie/CSRF/Host/Origin检查不变。Key仍只在.env配置，未配置Key不能开启；MCP Bearer鉴权保留。

持久化/兼容性：mcp.enabled作为可选字段写入现有.data/web-agent-settings.json，不改变文件权限和原子保存，已有文件不含字段时沿用MCP_ENABLED初始值，保存偏好后优先于env。普通Agent设置保存保留旧客户端未传的MCP值，两条保存路径共用configuring互斥。单独切MCP不销毁Runtime、不拒绝正在执行的Web/企微或取消已开始的MCP任务；关闭后新MCP请求（包括新轮询）404，重开可取回保留结果。四项累计及历史保持；完整管理统计/api/mcp/usage保留。

企微：原逻辑已在发送前读取联系人name，有备注就不附发送者ID，未备注保留ID帮助识别。此次修正未发出任何片段但已缓存parts的任务在重启后仍可能复用旧ID的边界，未确认发送前按最新name重建parts，去除首尾空白。已有成功片段保持原文/进度，不回改已发送消息。联系人页增加备注用于未来通知的英文说明，群/私同人按Bot ID+User ID规则不变，Web会话标题不作为联系人备注。

验证：新增MCP开关即时生效/保存重启/旧客户端保存不覆盖/鉴权/schema/无Key拒绝/累计保留及既有任务继续测试；企微补充缓存旧ID重启后新备注测试，以及真实本机HTTP管理员修改备注→Bridge联系人接口→私聊/群聊/改名后通知均使用名称且不含User ID。使用隔离数据、模拟模型/企微传输；未向实际用户推送、未改真实.env/联系人/知识或VPS。最终验证结果后补。

最终验证补充：完整`npm test` 148/148通过（约28.7秒），日志`.data/debug/mcp/settings-full-tests.log`；前端/Bridge语法和git diff检查通过。首轮定向发现既有英文页面测试把旧/mcp-usage预期为200，已按新的302跳转契约修正，生产路由未改回旧页面。隔离浏览器确认侧栏不再有MCP入口，Settings内仅四项累计与开关，关→刷新保持关→重新开即时保存且累计1420不变，截图`.data/debug/mcp/settings-merged.png`（虚构统计）。测试tab和60219隔离服务已关闭。没有对生产域名进行启停、备注或推送操作。


## 2026-10-19 — 新建Excel与UTF-8文本输出

原因：用户要求从零输出Excel对比表，并输出HTML/MD/Java等文本文件；复用既有受控附件交付，不开放通用磁盘写入。

工具：新增excel_create(filename,sheets)及text_file_create(filename,content)，Web Settings独立开关且初始关闭；Core/FileTools默认仍仅原六项，旧六项偏好迁移补两项false，FILE_TOOLS_ENABLED=true不误开新能力。原有工具注册、模板patch的逐XML改动/公式保护保持。可选表头/矩形数据/多表/列宽/数字格式/冻结/筛选；新建Excel单元格仅字面文字、有限数值、布尔/null，=前缀也为文字，不提供公式/宏/外链对象。每表≤5000行/200列、≤20表且遵守配置总单元格/表数；生成后Office预检、ExcelJS逐格核对才发布。文本UTF-8保持内容/换行，≤262144字符且编码≤1MiB，拒绝NUL/非法UTF-8，不编译/运行/部署源码。

文件边界：输入/输出扩展名白名单分开，上传仍原五类；输出允许xlsx或受限文本/源码后缀。无输入创建任务使用独立work目录，统一worker/队列/超时/取消；文本不加载Excel/Office解析模块，无新依赖或转换器要求。发布随机UUID磁盘名，model只给展示名，不可指定目录/覆盖/写.env等点文件，拒绝符号链接/硬链接/超单文件及会话配额，补充输出200文件上限。产物400，失败清临时目录且不登记输出。HTML按原octet-stream+attachment/nosniff/CSP下载，不在Agent域内执行。

交付：复用generated-file-v1/run关联、实时output事件和前端下载卡片，扩展旧工具结果恢复白名单以恢复两种creator输出。Web/企微受控file下载及Bridge generic file发送复用，无需模型文字含文件名，文件模块关闭/重启仍可下载既有输出，会话删除/30天到期同步删除。MCP textOnly即使Web全开八文件工具仍不注册/执行文件写入。Skill模板增加新建指导与text文件Skill，均无需专属MEMORY，不改业务Skill和记忆。

验证：新增5项真实文件creator测试（多表/样式/每值/Unicode/空值/文字公式、21种文本扩展、无模板/无转换器/无视觉、路径/覆盖/schema/符号链接/限额/超时取消/默认关闭旧偏好/过期）及Web真实SDK+模拟模型下载卡片/HTTP安全头/关闭重启恢复/删除，企微全链路文本提问→Core→真实xlsx/html/java/md字节→模拟发送。MCP测试扩大到Web八工具全开，仍无文件工具。完整npm test155/155通过（约21.8秒）；后续production专项和浏览器验证后补。未调用真实模型/企微、未修改实际.env/业务资料/记忆/联系人或VPS，未提交推送。

最终验证补充：`npm run test:file-create`实际以NODE_ENV=production、空FILE_WORKER_IMAGE执行，5/5通过（约6.8秒），不依赖MarkItDown/视觉；日志`.data/debug/file-create/production-tests.log`。完整155/155结果不变（此后仅补文档/npm便捷命令，无运行逻辑改动）。浏览器隔离测试确认两项初始关闭，单独开启保存后，纯文字提问生成comparison.xlsx和example.html，最终文字不含文件名但均有下载卡片；刷新恢复两张卡片，Settings两开关仍开启，其他六项仍关闭。截图settings.png/web-outputs.png统一`.data/debug/file-create/`，内容和用量为虚构夹具。前端语法及git diff检查通过；测试tab和65284隔离服务已关闭。未在真实VPS/Linux或真实企微/模型验收新工具，也未修改实际用户设置、业务资料或部署状态。


## 2026-10-19 — MCP临时.env测试隔离修正

原因：用户VPS npm test在mcp.test.mjs原197行得到401而非200。本机注入虚构MCP_API_KEY后精确复现同一断言；src/config.ts导入dotenv/config会将部署.env载入process.env，而服务端正确使用显式options > 进程环境 > cwd临时.env的优先级，旧测试删除options.apiKey后错误假设仅临时.env生效。

修正/影响：仅修改测试，保留生产鉴权和配置优先级。用虚构进程Key显式验证它覆盖临时.env，再临时移除本测试进程的MCP_API_KEY验证磁盘读取，finally恢复原值。既不覆盖真实.env，也不打印/发送真实密钥；查询仅使用隔离本地服务，无新模型请求。避免部署环境中已配置Key导致假失败，并保留错误Key拒绝验证。验证结果后补。

验证补充：修复前以虚构MCP_API_KEY注入进程，精确复现原197行401≠200（.data/debug/mcp/env-repro.log）；修复后带同样注入`npm run test:mcp`15/15通过，进一步同时设置MCP_ENABLED=true和虚构进程Key运行完整`npm test`155/155通过（约22.1秒，.data/debug/mcp/env-full-tests.log）。git diff检查通过。本次仅测试与记录改动，生产运行代码/真实配置不变，未提交推送或部署。

## 2026-10-20 — Synchronize 产品知识维护

原因：用户要求把资料消化、版本/slot 判断和 Markdown Hub/Vault 索引维护部署到原有 VPS 服务，采用管理员手动开始和报告反馈，避免原件误删与问答读到半完成的知识库。

实现：在 **ProductExpertCloud** 增加 `/synchronize` 英文独立页面，侧栏入口、批量上传/手动 inbox 扫描、开始/停止、历史报告、内容 diff、文字反馈/Re-Sync，以及自然语言删除 Preview → Confirm deletion。`/api/sync/*` 使用现有管理员 Cookie、Origin 和 CSRF；WeCom/MCP 凭证无维护权限。浏览器断开不取消后台任务。没有定时 Sync、网站/微盘采集或普通聊天维护工具。

维护边界：版本管理的 `resources/knowledge-sync/SYNC.md` 作为独立 Pi 会话规范，无五轮裁剪、业务 MEMORY、Bash、任意写工具或联网工具。只读本批候选和产品知识，暂存 Vault 修改，输出结构化方案。后台强制完整候选读完、路径/保护文件边界、目标 slot、产品 Hub 与共享回链、依赖页审阅、旧路径清理、新链接可解析、index/log 维护及基线哈希一致。历史已缺失原件保留为历史信息。分类/版本证据和事实依赖仍由模型判断，不把结构校验描述成业务事实的形式证明。

转换：新增维护专用完整提取入口，不复用聊天截断正文。PDF 逐页渲染、Office 原生 LibreOffice 渲染、图像分区识别；XLSX 全工作表值/公式/备注/合并关系，Office 结构文本补充与 UTF-16 私有副本规范化。逐页/区域覆盖、视觉 usage 和缓存持久化；视觉不完整、截断、缺字体/依赖/配置、受限 XLSX 视觉覆盖、宏/嵌入/外部加载内容等停止入库。未调用模型的真实文件转换和模拟/真实视觉验证区分记录。已成功转换但待审/失败/中断的输入保留，成功才清理原件及前序尝试临时文件；同批重复也不会二次发布。

持久化与兼容性：`.data/knowledge-sync/` 保存 JSON 任务/尝试/报告、JSONL 事件、转换覆盖和恢复事务。发布与普通 Web/WeCom/MCP prompt 共用读写锁；等读者结束后核对基线、备份旧 Markdown、完整发布或回滚。回滚失败封锁知识访问，重启先恢复再开放 HTTP；未完成任务 Interrupted。备份 90 天，报告/反馈/legacy 审计不跟随聊天 30 天清理；旧资料再进入可上传并审查，未加下载黑名单。历史全文按需读取，常驻摘要；批次完整 Markdown 默认 16 MiB、候选索引 8 MiB，超限保留输入不截断。单任务、共享文件队列/模型并发；默认每文件 30 分钟/64 文本请求/128 视觉请求。

普通聊天仍无新增写工具；原生 grep/find/ls 保留工具名，改为在搜索前排除 newly_added/knowledge-sync，直接 read/file-tool 入口同样拒绝未发布路径。文件模块关闭时保留原来的普通读取范围，只额外排除维护目录；不改变 SKILL/MEMORY 注入、五轮上下文、附件/Excel 输出、WeCom/MCP 会话逻辑。新的 prompt 读锁支持排队取消并保留同会话并发拒绝。

运行配置：新增 `SYNC_*` 预算/soffice 配置与 `npm run check:sync`、`npm run test:sync`；systemd 取消整个产品目录的只读挂载，保留 SKILL/MEMORY/SYNC_PROMPT、UMS 和 file-runtime 只读保护，TasksMax=192。部署说明提醒保留用户已有 root/专用用户设置，并停止旧脚本/rsync 覆盖正式知识目录。没有变更本机 .env 或正式知识库，没有推送代码/部署 VPS。

验证：完整 `npm test` 172 项通过、无跳过；Synchronize 定向场景及真实 Pi SDK 的模拟模型工具循环覆盖发布、审查重试、重复、删除预览/过期、启动恢复、清理失败重试、90 天备份、文件变化、目录保护、旧引用、权限和预算。真实本地 PDF/DOCX/PPTX/PNG/JPG/WebP、扫描 PDF、UTF-16 Office/备注、多工作表 Excel/公式/合并转换通过，视觉 API 模拟的结果不当成识别准确性证明。浏览器隔离实例验证导航、选择、开始、报告、Re-Sync、刷新恢复与输入稳定性。真实 DeepSeek Flash 在合成知识库完成一次版本更新和原件清理（8 请求，已记录输入25436/输出2053）；额外真实多版本批次遇到未来日期/遗留引用，保留输入进入 Needs review；真实 qwen3.8-flash 识别合成测试图（输入230/输出58）。Ubuntu24 ARM64、Node24 本地测试容器中原生 PDF/DOCX/PPTX/图片转换通过，2CPU/1100MiB 内存上限下测试组峰值404598784字节；视觉为模拟端点，不代表实际 x86_64 VPS、复杂大文档或并发聊天压测。详情见 `dev-history/2026-10-20-synchronize.md`。

## 2026-10-20 — Synchronize Tab 布局、忽略说明文件与独立100MiB上传

原因：用户要求忽略待处理目录中的 README.md，并把 Incoming files、Sync reports、Delete knowledge 分成 Tab，而不是全部堆在一页；维护上传放宽到100MiB，普通对话附件30MiB保持。

行为：扫描按文件名忽略任意大小写的 README.md（包括子目录），已有文件保留；上传 README.md 返回 ignored，不写入待处理目录，也不参加 Sync。维护上传使用独立常量100*1024*1024，列表上报、流式写入上限、错误提示和维护 converter 配置统一使用该值。未修改聊天 FILE_MAX_BYTES、.env 或.env.example。原有转换展开/页数/模型预算不随输入上限扩张。

界面：新增仅供 Synchronize 使用的CSS，移除其对共享样式的布局依赖；改为 Incoming files / Sync reports / Delete knowledge 三个可键盘操作的Tab，一次仅显示一个tabpanel，开始、Re-Sync、删除预览自动切换到报告。上传与选择/启动操作集中，增加全选与拖放；报告历史和详情按宽度响应式排列，状态、Token、差异、反馈分层展示。页面刷新恢复所选Tab/报告，保留轮询期间的选择和反馈。

部署：本次更新无新增env/systemd变更。现有Nginx如限制30m，应改client_max_body_size为100m并检查reload以允许较大维护上传；聊天后端仍单独限制30MiB。部署说明已更新。

验证：构建、前端语法检查与完整 npm test 共173项通过，无跳过。新增真实流式100MiB边界/多一字节拒绝/临时文件清理、31MiB管理员HTTP上传、Sync100MiB与聊天30MiB同时上报、README上传忽略与嵌套大小写说明文件扫描忽略。隔离浏览器验证三个Tab只显示一个区域、刷新恢复、键盘切换、选择/全选、启动自动切报告、切Tab保留反馈，以及Re-Sync后发布和差异展示。界面使用模拟planner/converter及测试资料，没有请求真实模型或修改正式知识库；未部署VPS。详见dev-history/2026-10-20-synchronize-ui.md。

## 2026-10-20 — Synchronize 视觉边界切图修复

原因：用户VPS单页PDF第一次视觉检查成功，第二次请求HTTP400。实际转换代码在1191×1684页面完整覆盖后，仍按1680步长生成1191×4底部细条；真实本地PDF渲染及模拟接口重现相同两次请求/一次成功覆盖记录。没有取得该次真实接口错误正文，故不把模拟拒绝当成供应商拒绝原因的直接证明。

修改/兼容性：横纵方向统一使用完整覆盖后停止、最后区域贴齐边缘的偏移规则；每块最大1800像素，至少120像素重叠，不跳过边缘内容。1191×1684及1800×1800只发送整图；1801及更大尺寸分块不产生窄尾条。转换缓存版本2→3，旧转换重建区域，逐区域内容哈希缓存仍可复用；失败条目可直接Re-Sync。维护视觉HTTP失败读取最多64KiB错误正文，报告包含失败区域及最多1000字符的接口错误原因，优先提取JSON错误字段，脱敏API Key、Bearer和图片Base64，不输出整份结构化请求。不改变聊天视觉工具、业务资料、.env、依赖或systemd。

验证：`npm run test:sync`21项通过、无跳过；覆盖1至10000像素的完整覆盖/重叠/无重复区域，真实PDF1191×1684及多种边界PNG的实际视觉请求尺寸、失败保留原件且不生成成功转换缓存、结构化错误原因脱敏和超长流取消。完整`npm test`176项通过、无跳过（约16.6秒），git diff检查通过。视觉接口均为本地模拟，未请求真实模型、未修改正式知识库或部署VPS。日志在`.data/debug/sync-vision-fix/targeted-tests.log`和`full-tests.log`。


## 2026-10-20 — Synchronize 文本模型改用 DeepSeek Pro

原因：用户要求Sync使用deepseek-v4-pro，并与现有模型共用API Key。

行为/兼容性：仅维护planner固定覆盖modelId为deepseek-v4-pro，报告同步记录实际文本模型名。继续复用现有BASE_URL/API_KEY、全局思考强度和上下文/输出上限，新增、更新、Re-Sync和删除预览均生效。聊天MODEL_ID及VISION_LLM_*视觉模型保持原样，无新增环境变量、依赖或数据库迁移，未改实际.env；.env.example仅更新说明。

验证：npm run test:sync共21项通过、无跳过（约16.4秒）。真实Pi会话使用本地模拟端点，验证请求model为deepseek-v4-pro、Authorization沿用同一测试Key；管理员HTTP任务报告记录Pro，聊天状态仍保留Flash。其余转换/发布/恢复专项回归通过。未调用真实Pro模型、未部署VPS。日志.data/debug/sync-pro-model/tests.log。


## 2026-10-20 — Synchronize 维护模型回退

原因：用户要求撤销上一轮单独指定Pro，统一通过.env管理模型。

行为/兼容性：撤销Sync的deepseek-v4-pro覆盖，planner和报告重新使用共享MODEL_ID/BASE_URL/API_KEY及全局思考强度；视觉仍使用已有.env中的VISION_LLM_*，不新增模型字段。不修改实际.env，不撤销之前的切图修复。前一条Pro记录仅说明当时的临时实现，本条为当前状态。

验证：构建与维护Agent/管理员HTTP两项针对性测试通过、无跳过；验证Sync报告和聊天状态均为同一个配置模型。模拟模型端点，未请求真实模型或部署VPS。日志.data/debug/sync-model-undo/tests.log。


## 2026-10-20 — 按Skill集中存放主记忆与额外记忆

原因：用户要求主/额外记忆统一放在.data/memory/<skill_name>，并以Cloud为记忆唯一准源；本轮先改代码，实际文件由用户按指导迁移。

行为/兼容性：产品主记忆必需路径改为.data/memory/urovo-product-expert/MEMORY.md；额外记忆改为同目录MEMORY_EXTRA.md，缺失/空文件仍有效。SKILL和知识根目录不变，UMS仍按需读取且不注入UMS记忆。上下文标题、分段、注入顺序、每轮新快照/同轮固定快照及五轮窗口保持。Web资源状态同步检查新主记忆路径；记忆工具仍仅可操作固定额外文件，无路径参数、不允许主记忆写入，条目格式/ID/作者邮箱/版本并发检查及原子保存/历史备份路径不变。新的两级记忆目录均校验符号链接。旧位置无自动回退/复制/合并/删除，缺少新位置主记忆时在推理前失败，避免读取错误数据源。

部署：systemd主记忆ReadOnlyPaths移到新位置，父目录保持可写供MEMORY_EXTRA原子替换；保留用户root账号和其他保护。.env.example仅更新说明，无新配置或依赖。README/技能模板/部署和Sync说明同步，docs/memory-layout-migration.md提供Cloud停服备份、手动迁移、防覆盖、归属权限、unit调整和重启步骤，提醒停用Mac旧记忆覆盖并从Cloud取本地副本。本轮没有移动本地真实.data、修改.env/本地同步脚本、修改patrick-agent或部署VPS。

验证：记忆/会话/Web针对性49项通过，完整npm test共176项通过，无跳过（约28.2秒）；覆盖实际SDK发送的每轮单份注入、工具轮内快照与下一轮重读、恢复/五轮裁剪、新主记忆缺失且旧文件存在仍拒绝、旧额外文件保持不读不写、主记忆保护/路径覆盖/主记忆ID拒绝、额外文件与两级目录/备份目录符号链接拒绝及Web/WeCom/MCP兼容。均使用隔离数据与模拟模型端点；未用真实记忆或真实模型验证。日志.data/debug/memory-layout/{targeted-tests,full-tests}.log。


## 2026-10-20 — 管理员 Memory Injection 主记忆维护

原因：用户要求在Synchronize上方增加Memory Injection入口，单个Dialog输入自然语言，由AI判断新增/修改/删除；有歧义时提示，明确后先预览再由管理员确认写主MEMORY，与普通聊天额外记忆写入隔离。

界面/API：侧栏新增入口及独立CSS/JS，对话框有输入、Generate preview、说明/疑问、逐条ADD/UPDATE/DELETE与前后完整条目、记录Token和Confirm injection。编辑输入会隐藏旧预览确认；关闭不取消后台任务，同浏览器刷新后凭sessionStorage预览ID恢复。新增管理员POST /api/memory-injection/previews、GET /previews/<id>、POST /previews/<id>/confirm，沿用Cookie/Origin/CSRF，拒绝机器凭证、路径/正文覆盖参数，创建/确认202后轮询。后台只接受已保存预览ID执行，不信任浏览器回传的内容或操作。

模型/边界：独立Pi会话共用.env连接和模型、全局强度、上下文/输出上限，只提供提交建议的内部preview_main_memory工具，不加载业务Skill/额外记忆，不提供文件/网络/写工具。管理员请求与当前主记忆分隔为数据，提示不猜测缺失事实和含糊对象，正文标题从###起步；有questions时不允许任何操作。每次最多30条、正文每条64000字符、主记忆2MiB、输入16000字符，单次3分钟/8文本请求，共享RunGate；无新模型或.env字段。

保存/兼容性：只写.data/memory/urovo-product-expert/MEMORY.md。复用现有条目格式解析/渲染，不改普通memory工具的路径和增删改语义；共享解析器可区分主/额外格式错误。后台产生新增ID/北京时间戳/unknown@email.com，更新保留原ID/作者/创建时间，未涉及条目保留原文。文件哈希绑定预览30分钟有效，确认取得共享知识写锁，等待问答后重新校验、备份、原子发布；过期/变化/符号链接/硬链接/坏格式/重复目标拒绝。重复确认已完成预览不重复写。预览和确认记录保留在.data/memory-injection/<id>.json，备份在.data/maintenance-backups/main-memory/<id>.md，不随会话30天清理。重启将未完成预览标记失败；发布中断根据前后哈希恢复为已完成/待确认/冲突；发布成功但确认回执保存失败不误报成未写入。

部署：模板取消主MEMORY单文件ReadOnlyPaths，保留SKILL/SYNC_PROMPT/UMS/file-runtime保护，普通模型仍无主记忆写工具。已有VPS须手动删除实际unit中的主记忆只读行、daemon-reload再启服务，不能只git pull。保留用户root账号；无需新服务/依赖/env/记忆迁移。README、VPS、记忆迁移及Sync说明已同步；详见docs/memory-injection.md。本轮没有修改本地实际记忆、.env、Cloud服务或patrick-agent，未提交推送。

验证：完整npm test182项通过、无跳过（约28.2秒），最后错误文案区分主/额外后再次构建并跑相关10项全部通过。新增六组测试覆盖批量预览不写/确认备份和元数据/额外隔离、含糊/坏方案/越权字段/重复目标、哈希冲突与过期/读锁等待、重启恢复和幂等、链接/坏格式/备份拒绝/关闭取消，以及真实Pi SDK连接本地模拟模型的管理员HTTP端到端（.env同模型与强度、仅内部预览工具、Cookie/CSRF/Origin/机器Key拒绝）。浏览器在隔离知识库验证侧栏入口、生成预览无文件变更、编辑隐藏确认、确认后主记忆改变而extra不变、歧义无确认按钮、刷新重开恢复；模型判断/用量为测试夹具，未请求真实模型。日志与截图统一.data/debug/memory-injection/。语法及git diff检查通过。


## 2026-10-20 — Memory Injection 主记忆下载

原因：用户要求在主记忆维护对话框增加Download Memory File。

行为/兼容性：底部增加独立下载按钮，管理员GET /api/memory-injection/download返回当前固定路径主MEMORY.md的原始字节，使用Markdown附件Content-Disposition和no-store。浏览器以MEMORY.md保存，显示下载中/错误并保留原有预览状态；不调用模型、不保存审计或修改任何记忆，不导出未确认预览或MEMORY_EXTRA。复用普通文件/符号链接/硬链接及2MiB上限检查，格式异常或空内容仍可原样下载备份；不接受路径或查询参数。无Cookie/仅机器Key拒绝下载，不改变现有注入和增删改逻辑。无需.env/systemd或依赖改动，未部署VPS或修改实际数据。

验证：构建、前端语法和git diff检查通过，记忆相关11项测试通过、无跳过（约1.6秒）。验证UTF-8/BOM/CRLF原始字节保留、下载不写/不调用模型、链接拒绝、匿名/机器凭证拒绝、附件及缓存头、路径参数拒绝、预览未确认仍下载旧原文及确认后下载新原文，extra保持不变；真实Pi SDK连接本地模拟模型的原有预览确认端到端继续通过。未进行真实模型或VPS测试，日志.data/debug/memory-download/tests.log。


## 2026-10-20 — 聊天开放UTF-8纯文本附件

原因：用户企微发送TXT日志被原二进制类型白名单拒绝，要求开放TXT/JAVA/MD及其他纯文本，讨论后采用现有read/grep而不新增专用文本工具。

行为/兼容性：新增独立文本输入集合（原文本输出格式再加log/jsonl/tsv/markdown/jsx/tsx/mjs/cjs/ini/conf/cfg/properties），Web选择器/状态API/提示同步，Bridge使用构建后的同一FILE_EXTENSIONS集合并更新错误提示。上传使用流式UTF-8解码器校验，支持跨chunk多字节，拒绝非法/未完成编码和NUL，失败清理部分文件且不登记manifest；原字节/BOM/换行/哈希保留。原有30MiB及session总量/文件数量/鉴权/附件开关不变，旧版Office/可执行扩展名不开放；无新工具/开关/env/依赖。

读取：按消息绑定的附件brief和会话catalog为纯文本提供format及当前session绝对readPath；提示先grep定位大文件、再read按行读取，不自动把全文塞进上下文，源代码/HTML均为数据而不执行。原生read仅对二进制集合继续拦截，文本允许在现有当前会话/知识根边界读取，跨会话仍拒绝；知识根的二进制专用解析入口保持原格式限制。SDK日志/五轮裁剪/会话恢复和删除保留沿用原逻辑，输出白名单不扩大。

验证：完整npm test186项通过、无跳过（约27秒），构建/脚本语法/git diff检查通过。新增三组测试覆盖所有文本扩展名上传及逐字节中文/emoji/BOM/CRLF保真、NUL/UTF16/非法UTF8尾字节/超限/路径拒绝与部分文件清理；真实本机Web→Pi SDK→grep/read定位超过3.66MiB日志中的ACTION_PTT/KEYCODE_PTT，再读取相关行，请求载荷保持小于60000字符，确认下载原件一致、服务重启恢复可重读且跨会话拒绝；真实Bridge/API/Agent读取TXT/JAVA/MD/HTML/JSON引用附件、旧协议扩展名验证和现有文本输出回归。模型与企微传输为本地模拟，未连接真实机器人/模型，未修改业务数据或部署VPS。日志.data/debug/text-attachments/。部署必须重启product-expert.service和wecom-bridge.service以同步白名单，无需改systemd配置。


## 2026-10-20 — 手动 SFTP 来源拉取与持久报告

原因：用户需要从给定SFTP账号及仅path的JSONL清单拉取变化文件至newly_added；凭证放.env，报告指定.data/logs/sftp_sync。本轮明确暂不做定时任务与企业微信推送。

行为/兼容性：新增Synchronize第四个Source imports Tab，Run now/Stop、配置就绪提示、历史及逐文件状态/错误/实际名称/SHA256；独立于维护Start Sync，不调用模型或自动发布知识。新增管理员/api/sftp-sync/status、POST /runs、GET /runs/<id>、POST /runs/<id>/stop，返回202后沿用页面两秒轮询、Cookie/Origin/CSRF，WeCom/MCP凭证无维护权限。CLI npm run sftp:sync提供相同一次性拉取，失败/部分失败/停止退出码非零；npm run sftp:check-host无密码探测主机指纹；npm run test:sftp运行专项。

实现：ssh2只用lstat/open-read/close，不调用shell、不改远端；默认现代算法，SFTP_LEGACY_KEX=true仅追加旧Serv-U所需group14-sha1，固定OpenSSH SHA256主机指纹在发送密码前校验。JSONL UTF-8/4MiB/10000行、逐行错误、仅path、重复路径去重，拒绝穿越、控制字符、保留名、不支持格式、非普通文件。每文件100MiB上限、流式SHA256、默认256MiB磁盘保留、下载前后size/mtime及长度核对、20秒连接/10分钟每次尝试/最多三次/有限退避；连接错误耗尽、认证/指纹/磁盘问题停止余批，独立路径错误继续。纯SFTP不能在不读取内容的前提下比较远端哈希，因此未变化仍读取网络字节，但不会重复投递/入库；不以mtime代替内容哈希。

持久化：.data/logs/sftp_sync保存state.json、每run JSON报告/紧凑summary/JSONL事件、work暂存及proper-lockfile心跳锁。完整文件fsync后先保存待投递日志，再以独占硬链接原子暴露至newly_added，不覆盖同名；名称冲突带后缀，状态在投递后才推进。Sync消耗原件后哈希仍有效。HTTP/CLI共享单执行锁、支持跨进程停止标记；取消/失败清理未投递部分文件，服务重启恢复可验证的待投递事务并标记中断报告。目标被改或交付/记账间原件已被其他消费者删除、无法证明交付时停止审查，不盲目去重或重投。日志错误不静默更新哈希；密钥不回传、不写报告。缺少SFTP配置和恢复审查不禁用普通聊天。新目录/文件700/600；已有systemd .data可写范围足够，无新服务、无聊天工具变更。

配置/数据：新增ssh2/proper-lockfile及类型依赖，需要npm ci；.env.example、README、VPS及Synchronize说明更新，docs/sftp-sync.md给出具体配置与恢复。真实凭证仅加入本地Git忽略.env，创建忽略的.data/sftp_sync_paths.jsonl测试路径。未修改patrick-agent、未部署VPS、未提交推送，正式newly_added与知识正文未用于测试。报告/状态不随聊天清理，不能随Mac资料同步覆盖VPS状态。

验证：本机专项11项通过，无跳过，覆盖路径/JSONL、流式字节及去重、源文件被Sync删除后仍去重、同名不覆盖、网络重试成功/耗尽停止余批、单文件失败继续、远端变化、超限/磁盘不足、跨实例锁与停止、关闭与启动竞态不新建连接、已暴露硬链接的中断恢复/冲突、符号链接/配置缺失、管理员HTTP及凭证隔离；含真实本机ssh2服务端验证旧KEX显式开关、错误指纹在密码前拒绝、SFTP只读协议与流结束。完整npm test197项通过、无跳过；构建/前端语法/git diff检查通过。单元网络/文件错误用夹具，无真实模型调用。

真实远端验证独立进行：连接用户指定Serv-U 15.0.1.20，观测主机指纹并固定，不冒充第三方认证；只读取/os/i9100/SQ29MB/SQ29MB修改记录.xlsx。首次下载72681字节，SHA256 ff1569af0cc511c6389a284512ec2a340ff34dc2e10be060a67b348597a0c491，ZIP CRC及XLSX关键结构通过；第二次及CLI再次运行均Unchanged、无重复文件。浏览器在隔离数据根真实点击Run now，验证Downloaded→Incoming files计数1、再次Unchanged及持久报告。所有下载/截图/测试日志在.data/debug/sftp-sync/，其中live与ui各自有独立logs/sftp_sync；未写远端、未请求真实模型、未进行Ubuntu/VPS验收。


## 2026-10-20 — SFTP Node 22 活动任务提前退出修复

原因：用户在VPS Node 22.23.2运行测试时，跨实例停止用例等待未完成即收到“Promise resolution is still pending but the event loop has already resolved”，其后六项被连带取消。调查在本机相同Node版本复现原代码3项通过、7项取消；此前197项通过记录来自Node 25.6.0，不能作为Node 22或Ubuntu通过的证据，本条明确纠正验证范围。

行为/兼容性：活动SFTP任务的停止标记轮询不再unref，保证任务在等待停止信号或无其他活动句柄的超时时保持进程存活；成功、失败、取消等路径仍在finally清理轮询并释放锁。保持JSONL、哈希/发布状态、重试、报告及API格式不变，无.env、依赖或systemd改动，不触发知识Sync。新增独立子进程回归：没有真实socket的静默传输须等待超时、写入失败报告、不推进哈希/不发布部分文件，然后自行退出；父测试设置15秒上限检测定时器泄漏，避免仅在测试进程增加保活掩盖问题。docs/sftp-sync.md同步说明部署版本验证和更新方式。

验证：使用Node 22.23.2运行npm run test:sftp，12项全部通过、无取消/跳过；同版本完整npm test198项通过，0失败/取消/跳过，约35.5秒。隔离副本仅恢复旧unref行为时，新子进程用例按预期失败（尚未结束的顶层await提前退出），证明回归能捕获原故障。git diff检查通过。日志.data/debug/sftp-sync-node22-fix/{targeted,full-tests,original-regression}.log。测试在本机macOS/ARM64运行；网络为本机SSH夹具/模拟连接，未使用真实SFTP/模型、未写正式资料或.env、未修改patrick-agent、未部署VPS，也未代替用户提交推送。


## 2026-10-20 — Synchronize 新产品建议指令

原因：新产品资料需管理员明确授权创建目录和 Hub，用户希望报告给出可直接使用的提示词，避免记忆授权措辞。

行为/兼容性：维护 finish_sync 增加可选 suggestedFeedback，由同一次维护模型判断生成，无额外模型请求。SYNC.md 要求完整读取候选、检查现有库，产品身份与 slot 明确且仅缺创建授权时，按报告语言生成针对该文件的目录、slot、Hub 和相关索引指令；有身份/归属歧义、版本覆盖冲突或删除请求时不编造授权建议。带建议的提交须完整读取候选，后台仅接受 review 决策中的非空、最多16000字符草稿，review 不发布任何候选修改。建议保存于原有报告决策字段，沿用原有持久化；旧报告不要求该字段。

UI：逐文件 Needs review 中显示 AI-suggested instructions 和 Use suggested instructions。点击后才填入可编辑输入框，说明必须检查并点击 Re-Sync 才提交；不自动替换实际反馈，不自动执行。编辑或清空后轮询保留草稿。Re-Sync 沿用现有单文件新尝试、当前知识快照、转换复用、索引校验和历史保留机制；建议不进入可信反馈。无需修改.env、依赖或systemd；未修改正式知识库、patrick-agent，未部署VPS、未提交推送。

验证：本机 macOS/ARM64、Node 22.23.2，专项 test:sync 首次23项通过（前端回归加入前），新增实际前端渲染器/事件处理夹具1项通过；完整 npm test 201项全部通过，无失败/取消/跳过（约19.6秒）。覆盖 Pi SDK 接收可选建议字段及全文读取保护、建议不能发布、超限/空白拒绝、HTTP报告重启持久化、空白 Re-Sync 不采用建议、编辑后仅处理当前文件且重新读取外部更新、其他文件及历史不变。前端夹具验证文本安全显示、点击填入不发送请求、编辑/清空轮询保留、只有 Re-Sync 发送输入框内容及旧报告兼容。真实本机浏览器在隔离数据根确认建议展示、填入与修改，截图 .data/debug/sync-suggested-instructions/report.png；模型为脚本化/模拟响应，未请求真实模型或在Ubuntu验收。日志在同目录 targeted.log、full-tests.log。构建、脚本语法和 git diff 检查通过。


## 2026-10-21 — Prompt 完整预览与管理员系统指令

原因：用户需要查看普通问答完整 session/run 请求的组成，并维护作为 system 消息发送的追加指令，保存后无需重建对话。

行为：侧栏 Memory Injection 上方增加 Prompt dialog；模型参数、System 各分区、Messages 示例和 Tools 完整 schema 均可折叠，支持 Expand all/Collapse all、Standard/MCP。真实静态配置、能力说明、Skill 元数据、工作目录、完整产品 SKILL/主 MEMORY/EXTRA MEMORY 来自后台；附件、历史、本次问题和运行工具交互明确标注 Example，不读取真实会话、不调用模型。逐项 Add/Edit/Delete，草稿预览自动更新，保存前 Unsaved changes，关闭/Reload 有放弃草稿保护；保存期间冻结编辑，错误与并发冲突保留草稿。全局快捷键尊重所有已打开 dialog，避免编辑中触发新建对话。

Core：新增共享提示词分区/组装模块和共享工具工厂，实际请求与预览使用同一内容来源及顺序。管理员条目以 unordered list 注入 Administrator-provided instructions，紧随基础 system.md，仍属于同一 system 消息；不改写基础文件。run 开始时同时读取指令与知识快照，工具循环内保持固定，下次 run 重读；Web/WeCom/MCP/Core 共用，SYNC/Memory Injection 专用 Agent 不注入。保留五轮裁剪、附件绑定与工具权限；指令不写入 SDK transcript。现有无配置部署为空列表，继续原行为。

持久化/接口：.data/prompt-instructions.json（Git 忽略、普通文件600），最多100项/每项2000字符/合计64KiB UTF-8，拒绝空白及控制字符。固定路径、符号/硬链接检查、UTF-8/结构/文件大小校验，proper-lockfile 跨进程保存锁、revision 校验和原子发布；损坏时显式拒绝推理，不默默清空。GET /api/prompt、POST /api/prompt/preview、PUT /api/prompt 沿用管理员 Cookie/Origin/CSRF；仅允许指定字段，无任意路径或凭证返回。无新.env、依赖或systemd要求，添加 npm run test:prompt，README同步更新。已有 Synchronize 未提交改动保留；未改正式知识、Memory、.env或patrick-agent，未部署或代替用户提交推送。

验证：macOS/ARM64，Node 22.23.2 下专项13项、全量 npm test204项全部通过，0失败/取消/跳过，全量约26.3秒。用实际 Pi SDK 与本机 HTTP 模型夹具捕获请求，确认 system 文本和全部启用工具名称/描述/schema 与预览一致；同一 session 下一 run 更新、run 内两次推理保持旧快照、清空后移除指令段、MCP textOnly 无 memory/文件工具、坏配置推理前失败、历史不累积指令。真实 Web/WeCom HTTP 问答验证读取已保存新指令。管理员 API 覆盖登录/Origin/CSRF/机器凭证隔离、预览不保存/不建session/不调用模型、不暴露测试API key、重启保存、旧 revision 拒绝；存储覆盖并发、模拟磁盘写失败保持原内容和清理、大小/控制字符/符号与硬链接拒绝。

浏览器：在隔离数据根验证添加/编辑、自动预览、保存、展开/折叠、MCP模式工具从12项变5项、未保存关闭/继续编辑/放弃、重新打开保留已保存值；390px iframe 移动端夹具验证入口、布局和删除全部后保存。移动端仅测试代理移除 frame-ancestors 以允许同源嵌入，正式应用响应头保持原样。截图与日志在 .data/debug/prompt/（prompt-dialog.png、prompt-mobile.png、targeted.log、full-tests.log）；模型为本机模拟，未请求真实供应商或进行 Ubuntu/VPS 验证。构建、前端语法及git diff检查通过。

本轮最终复核：补充 agent_start 重入时保留当前 run 快照（仅在存在新 run 预读快照时替换），以及保存成功后收起未保存放弃提示。最终 Node 22.23.2 全量仍为204项通过、无失败/取消/跳过，约19.1秒；上文26.3秒为首次全量耗时。语法及git diff检查再次通过，临时浏览器页面和测试服务已关闭。

## 2026-10-21：Synchronize 批次转换、Hub 确认与索引维护修复

原因：生产批次的修改记录含 21–83 张小工作表，被与聊天共用的 20 张限制拦截；内嵌 XLSX 和 `K388 Pro`/`K388-Pro.md` 命名差异分别触发转换、Hub 校验；模型整页输出约 96k 字符历史 log 导致大量重复 Token。管理员明确要求跳过内嵌 XLSX，不配置永久映射，改为确认发布，并移除删除页的 Reconvert。

行为与兼容性：

- 维护转换单独固定最多 200 张工作表，保留现有 XML 单元格、解包大小、页数、像素、超时、进程内存等限制；聊天 `FILE_MAX_SHEETS`（默认 20）及 30 MiB 上传不变。超限显示实际数量、上限和触发部件。维护缓存版本升为 4，旧缓存下一次 Re-Sync 会重新转换。
- 仅私有转换副本移除内嵌 XLSX、内部关系及其 shapeId 明确关联的预览图标，不打开嵌入文件；覆盖记录及发布 Markdown 明确注明省略内容。其他嵌入格式、宏、ActiveX、外部加载仍拒绝，真实图片/图表仍需视觉覆盖。
- Agent 可提交本次 `productHubs` 选择，不建立永久映射。使用非同名现有 Hub 时仍检查路径、完整来源覆盖、依赖与链接，随后进入逐文件 Awaiting confirmation；管理员点击 **Confirm publication** 才写入。确认校验基线，外部或同批其他发布造成的变化要求 Re-Sync，不能用点击确认绕过。批次执行完之前保持 Running，多个待确认项目须指定 itemId。成功后才清理对应原件，失败保留。
- 新增维护专用 `patch_candidate`：旧正文 SHA256、唯一匹配片段、原子候选变更和原有大小/权限限制。`finish_sync.logEntry` 只含本次条目（未填则用 summary/reason）；后台保留 log 原文后追加，模型不能重写历史 log。历史 log 不再作为清除旧来源路径的活跃依赖，其他索引页仍须复核。旧报告继续可读。
- 状态分别为 Pending / Converting / Converted waiting / Analyzing / Publishing；重启时未完成转换/分析仍标记 Interrupted。删除报告隐藏 Reconvert，补充输入和按钮改为 Instructions for deletion preview / Regenerate deletion preview；只生成预览，仍需 Confirm deletion。
- 无新增环境变量、依赖、systemd 或自动任务。更新 README、Synchronize 使用/API 文档。未运行正式 Sync、未部署或修改 VPS 知识数据。

验证（本机 Node 22.23.2）：

- TypeScript 构建通过，全量 **210/210**，无失败、跳过或取消。覆盖实际 worker 的 200 张工作表、201 张拒绝、聊天仍 20、单元格预算、嵌入跳过、未知嵌入拒绝、保留非目标图形；SDK 接模拟模型验证局部修改、旧 hash/重复片段拒绝、日志写保护；隔离知识副本验证确认前不发布/不删源、日志完整保留、单文件/多文件确认、过期预览拒绝及转换等待状态。
- 实际资料隔离转换：`SQ29M修改记录.xlsx` 83 张表 → 153184 UTF-8 字节；`SQ29MB修改记录.xlsx` 6 张表 → 54650 字节，明确跳过 `xl/embeddings/Workbook1.xlsx`；`K388Pro海外版本修改记录.xlsx` 2 张表 → 13241 字节。当前版本从原件重新转换，三份原文件哈希均未改变；未发布到业务库。
- 浏览器实际检查隔离管理员页面：删除报告没有 Reconvert，显示 Regenerate deletion preview；Hub 报告显示路径和 Confirm publication。截图、转换日志及全量测试结果在忽略目录 `.data/debug/sync-fixes/`。
- 上述模型测试为模拟文本/视觉接口，真实文件转换使用原生依赖；本轮没有真实模型判断/发布验证，也没有新的 Ubuntu 2G 资源实测。此前的生产限制调查与本机成功转换不能作为真实模型发布成功的证据。


## 2026-10-21：企微提示调整

- 原因：管理员要求后端升级时给出可读提示、关闭进入聊天的欢迎语，并统一等待提示；本轮明确要求不做验证。
- 行为：AgentApi 将连接故障与 HTTP 502/503/504 包装为独立不可用错误，用户看到“服务正在升级中，请稍后尝试。”，认证与其他业务错误保留原有处理。Bridge 启动探测最多等待 3 秒；除 401/403 外，Agent 尚未启动不会阻止机器人上线。移除 enter_chat 欢迎回复，消息初始及空白流式等待提示均为 `AI Thinking...`。已有可能执行的 run 不自动重放，保留恢复流程，不可用期间只提示一次。
- 兼容性：无新环境变量、依赖或 systemd 修改；发布代码后需重启 `wecom-bridge.service`。不改真实机器人配置，不直接连接企微或部署 VPS。
- 验证：按管理员要求，未运行构建、测试、浏览器/服务启动验证或真实机器人验证。此记录只说明代码修改，不宣称验证通过。


## 2026-10-21：待决选项界面

- 原因：管理员不希望从长段报告里手动复制选项，要求可点击选择且保留自由输入；沿用本轮不做验证的要求。
- 实现：`finish_sync` 增加可选 `reviewQuestion` 和 `reviewOptions`（2–8 项、唯一 ID、短标题、后果说明、完整反馈指令），仅 action=review 可带，校验文本与长度，并要求带选项的 Agent 先读完候选全文。专用 SYNC 规范要求针对实际问题生成互斥选项，不编造权限。
- 界面：未预选的原生 radio 卡片、键盘可操作、选择样式、Clear selection、Additional instructions、可展开的完整选中指令。问题与操作区前置，reason/summary/versionEvidence 默认折叠。只有显式点击 Re-Sync 才组合提交反馈，不新增后台发布权限；有选项但未选择且未输入时禁用空提交，仍可清空选择并仅输入自由文字。
- 兼容：旧报告有明确“选项 A / Option A”单行文本时，将原文作为卡片反馈，不用模型推断或默认选择；其他旧报告保留原输入。选择在当前页面等待提交，刷新不自动恢复授权。新反馈沿用现有持久化与尝试历史。无新接口、配置、依赖或 systemd 变更，既有业务和安全校验保持。
- 验证：按要求未运行构建、测试、浏览器/真实模型或部署验证；不宣称验证通过。未修改正式知识库、Memory 或 VPS 数据。


## 2026-10-21：主记忆单附件

- 原因：管理员需要在 Memory Injection 的文字要求旁附一张图片或一份文档，一次一份，仍先预览再确认。沿用此前不执行验证的要求。
- 界面：新增 Attach file、文件名/大小卡片、Replace file 与 Remove；Generate preview 时上传。文字仍必填，更改文字或附件隐藏旧确认，恢复已有预览时恢复附件元信息。单文件30MiB，支持现有图片、Office/PDF和UTF-8文本类型。
- 后台：新增管理员单文件上传/删除接口及可选 attachmentId；保留 Cookie、Origin、CSRF 和机器凭证拒绝规则。独立受管文件目录 `.data/memory-injection/files/memory-<uuid>/`，拒绝链接和任意路径，上传时复用文件名、大小、UTF-8校验。24小时清理在启动/上传执行，原件总预算512MiB、最多64目录。操作期间拒绝替换/删除。
- Agent：有附件才注册受限 `read_memory_attachment`，由固定文件类型转发只读文件工具，或分段读取唯一UTF-8文件。无任意文件、网络、命令和写工具。内含指令不构成权限；附件未成功读取不能提交修改。仅抽取管理员要求中适合长期保存的事实，不整篇复制。读取沿用聊天工具的限制/视觉配置，不引入完整SYNC转换或LibreOffice依赖。
- 运行与兼容：纯文字3分钟/8次请求不变；附件预览5分钟/24次文本请求、20次读取，视觉保留已有预算，独立显示已记录视觉Token。只改主Memory预览入口，不改MEMORY_EXTRA、正式知识库或聊天附件。无新依赖、env或systemd要求；旧文本请求和预览记录继续兼容。
- 验证：依管理员要求未运行构建、测试、浏览器、真实文件读取、模型或机器人验证，也未部署VPS。这里仅记录代码实现，不宣称验证通过。


## 2026-10-21 — 每周资料库导入

- 原因：资料库每周更新，管理员只需要检查最新完整报告的 added/updated，挑选指定五类文档送到 newly_added，再自行启动知识 Sync；不回溯、不跟踪远端删除、不推送企微。
- 实现：新增 `src/library-import/` 配置、公开 HTTPS/DNS 固定解析下载、纯元信息分类器、独立文档结构检查子进程、持久服务与 CLI。通过 key 合并当前文件清单、去重变化；支持 PDF/PPTX/XLSX/DOCX ≤100 MiB，排除旧格式；分类为 accessories_guide / product_brochure(PB) / presentation / specs / user_guide / outside / uncertain，仅前五类下载。共用现有文本模型/思考设置，整批快照，无工具/知识/Memory 注入。
- 一致性与错误处理：原子状态/JSONL 报告、分类缓存、按来源+内容去重、同名异内容另存 __library 后缀、预发布日志及经证明的发布恢复、跨 Web/CLI 心跳锁和停止标记；有限重试、超时、磁盘余量、长度/实际格式/XML/CRC/PDF 检查。认证或磁盘/连接批次故障停止其余文件；不明确的崩溃发布保留状态并要求人工处理，不猜测已投递。CLI 崩溃后 Web 轮询可在锁过期后恢复报告。源二进制不进入正式资料区。
- 接口/UI：Source imports 分别展示 SFTP 与 Library 的配置、Run now、Stop、历史及逐文件状态/依据/实际返回 Token；`/api/library-import/status`、`runs`、`runs/<id>`、`runs/<id>/stop` 沿用管理员 Cookie/Origin/CSRF，机器凭证无权访问，不返回配置密码。普通聊天和已有 SFTP/Synchronize 改动保留。
- 运行/兼容性：新增 `.env.example` 的 LIBRARY_IMPORT_BASE_URL / LIBRARY_IMPORT_ADMIN_PASSWORD 占位；未配置时界面提示，普通问答仍可用。无新 npm 依赖；新增 `library:import` 直接运行 dist，不每周重建。独立 systemd service/timer 仅模板，每周一 Asia/Shanghai 06:00，Persistent 漏跑补一次；无需主 Web 服务在运行。README/使用说明补充部署步骤和边界。
- 验证结果：**按用户要求，本轮未运行构建、typecheck、测试、浏览器、真实模型、真实下载、VPS/资源或定时器验证。** 仅编写未执行的模拟测试夹具与后续验证清单；不能记为已通过。未提交/推送代码，未部署、未安装/启用定时器，未写入真实凭证或修改正式知识/Memory。

## 2026-10-21 — SFTP systemd 模板同步

- 原因：管理员已在 VPS 手工配置 SFTP service/timer，本地仓库缺少对应模板，要求以其贴出的 VPS 内容为准保存。
- 修改：新增 `deploy/product-expert-sftp.service` 与 `deploy/product-expert-sftp.timer`，保留 root、工作目录、直接运行 dist CLI、128 MiB JS 堆、256M 内存、50% CPU、2h/30s 超时及每天 Asia/Shanghai 03:00/Persistent 的配置；README 和 SFTP 使用说明追加模板安装步骤、与 Library 每周任务的独立关系、Git 不自动更新 `/etc/systemd/system/` 的边界。
- 兼容性：仅新增部署模板与文档，不更改导入实现、凭证、路径列表或已有工作区改动。与贴出内容一致的 VPS 无需重新安装或重启；仅凭 unit 内容不推断 timer 已启用。
- 验证：沿用管理员要求，未运行构建、测试、systemd 校验或真实 SFTP 请求；未访问/修改 VPS，未安装/启用任务，未提交或推送代码。配置来源为管理员提供的文本，非独立远端核验。

## 2026-10-21 — PDF 校验编译兼容修正

- 原因：管理员在 VPS 执行构建时遇到 `verify-worker.ts` 的 TS2353；新增 worker 使用了当前锁定 PDF.js 版本 `DocumentInitParameters` 中已不存在的 `isEvalSupported`。
- 修正：移除该无效参数，保留 `useSystemFonts=false`、`disableFontFace=true`、`stopAtErrors=true` 和原有隔离结构检查。未升级/新增依赖，未通过 any 或断言绕过类型检查，不改变聊天或 SYNC 的 PDF 工具。
- 验证：只读取本机已安装 PDF.js 6.1.200 的类型声明/构建源码及项目现有调用方式；沿用用户要求，未执行构建、测试或真实 PDF/模型/下载验证。VPS 报错为用户提供证据，本地修正尚未执行编译确认；未提交、推送或部署。

## 2026-10-21 — 资料库下载 User-Agent 修复

- 原因：VPS 已成功读取最新资料库报告并分类，但首个 PDF 下载返回 403，按既有规则停止后续文件。本机使用 Node 对同一公开 URL 仅发送 HEAD：无 UA 为 403；仅加 `User-Agent: Mozilla/5.0` 为 200（application/pdf）；仅加 Referer 仍为 403。
- 修改：HTTP 传输层默认加入 `User-Agent: Mozilla/5.0`，默认头与显式凭证头分开处理，避免新增 UA 意外触发禁止匿名重定向的判断；每次匿名重定向保留 UA，仍重新验证公开 HTTPS/DNS 地址。管理员 API 请求仍禁止重定向，文件下载不带管理员密码、Authorization、Cookie 或 Referer。补充使用说明及模拟回归夹具，覆盖初始/重定向 UA、凭证不转发和私网重定向拒绝。
- 兼容性：不新增依赖、不修改 env/systemd、去重状态或分类缓存。同步代码并构建后重新运行原任务即可重试失败和未尝试条目，无需清空状态。未改变 401/403 批次停止策略。
- 验证：故障定位证据仅为本机真实 HEAD 响应头对照；未进行文件 GET 下载或 VPS 远端核验。修复阶段沿用用户要求，未运行构建、typecheck、模拟测试、真实模型或下载验证；未提交/推送、部署或重启服务，不宣称 VPS 下载已成功。


## 2026-10-21 — 资料库发布 EXDEV 修复

- 原因：管理员提供 VPS 日志，403 修正后 PDF 已下载并通过校验，但从 `logs/library_sync/work/` 硬链接到 `newly_added/` 返回 EXDEV；模板两条 ReadWritePaths 可能形成独立 bind mount，不能依赖底层同盘保证跨挂载硬链接成功。
- 修改：下载/校验临时文件移入 `newly_added/.library-import-work/`，与最终目标处于同一可写挂载；扫描已有代码忽略点目录，暂存不进入待处理列表。状态增加可选 location=inbox 标记，旧版无此字段仍按日志 work 解析；磁盘检查覆盖日志和暂存两处，清理兼容旧/新目录。systemd 模板只补注释，保持两条原有写入范围。
- 恢复：仅当旧失败报告匹配来源身份、报告完成指纹和 SHA256，明确记录对应路径的 EXDEV link 失败，且目标不存在时，将完整旧暂存复制到隐藏目录、校验/fsync、持久化新位置后发布并修复原报告条目。未完成的私有迁移副本可复用或重拷；已记录迁移的新尝试不再借用旧 EXDEV 证明，未知崩溃/目标冲突/哈希变化继续失败关闭。不要求清空去重状态或重新下载已验证输入。
- 兼容性：无需新增依赖、env 或已安装 systemd/timer 配置调整；管理员同步构建后重启主服务并重跑独立 service。保留现有工作区改动，未修改正式知识/Memory、凭证或 VPS 文件。
- 验证：只读取管理员日志、代码及 Incoming 忽略点路径的逻辑；新增/调整未运行的模拟夹具，覆盖收件目录隐藏暂存、取消清理、旧 EXDEV 安全恢复、哈希变化及不明确/已迁移尝试拒绝。沿用用户要求，未执行构建、typecheck、测试、真实下载、模型或 VPS/systemd 运行验证，未提交/推送/部署。不宣称远端已修复。

## 2026-10-22 — 相同正文的产品来源关联

- 原因：管理员指出 i9600 与 i9600 Mini 共用相同修改记录，原全局输入 SHA256 去重直接标记 Duplicate，并清理原件，使 Mini 缺少来源入口；旧 Re-Sync 反馈也可能被同样的提前去重跳过。管理员要求以最小风险修正，保留现有正常功能，并提供旧记录修复步骤。
- 去重边界：两处快捷去重共用同一条件，仅同名同内容、无反馈/重转换/前序尝试、原有型号 Hub 覆盖完整的普通重复输入保留快捷路径。不同名称、明确反馈或 Re-Sync 会核对当前发布正文路径/哈希及实际 Hub→source 或 Hub→shared→source 覆盖；哈希一致不能自动认定全部型号适用。报告显示核验路径与实际覆盖型号。
- 受限补关联：新增 `associate` 与后端提供的可选 `existingSource` 上下文。专用 Agent 必须完整读取正文和所选产品 Hub；关联模式禁止 write/patch 候选页，不能切换成 add/update/delete。后端保留现有产品与来源所属型号，只生成追加式 shared 来源节点、产品 Hub 入口、index 和审计日志，保留原正文/物理路径/版本/各产品独立事实；节点有所有产品回链。不新增平行事实数据库，不改变普通问答检索工具。需创建新产品或涉及已占用/不明确的单文档 slot 时，交回正常身份/版本判断。
- 预览与兼容：新增关联必须显式 Confirm publication；有反馈的无变更结果也给出实际覆盖确认，不因保存了文字就声称已关联。无反馈、复核后全部覆盖的输入可 Duplicate。同一来源重复关联幂等，不重复追加日志。旧 Duplicate 报告增加 Review product coverage，不需原件仍在；从既有 Published 回执与当前正文证明来源，缺少/变化则 Needs review，不猜测修复。多份匹配必须明确完整来源路径，禁止任意择一。published/deleted 的通用重跑禁令保留。
- 事务与后续保护：沿用知识读写锁、整体基线、事务备份/回滚/恢复和输入哈希清理。只对该功能带标记的 shared 来源节点增加后续替换/删除保护：须覆盖所有关联产品并预览，来源改用新版本路径后保护仍跟随。原有一般来源和共享节点流程保留。无新增 API/依赖/env/systemd 配置；更新代码、构建并重启原主服务即可，未自动安装/部署。
- 验证：使用 **Node 22.23.2** 完成 TypeScript 构建及 35 项定向检查（association、既有 service、Agent、本地 HTTP、UI renderer）。全部使用临时知识库，模型为本地模拟接口，覆盖旧报告重启/原件缺失、不同名称相同输入、明确反馈、覆盖幂等、正文缺失/哈希变化、多来源歧义、越权候选/产品/slot、预览过期、部分索引写入失败完整回滚、后续共享删除/新版本保护，及既有上传/转换/清理/鉴权/CSRF 行为。UI 使用最小 DOM 执行实际 renderer/handler，非真实浏览器视觉验收；既有转换测试仅处理临时 UTF-8/XLSX，不读正式资料。调整原 HTTP 夹具忽略此前导入功能的隐藏暂存目录；修正删除报告输入标签优先级，避免显示通用反馈标签。
- 交付边界：README 与 synchronize 说明提供 Mini 的明确双型号反馈和逐文件预览步骤。**未调用真实模型、未执行全量测试、未修改正式知识/Memory/VPS 数据，i9600 Mini 的实际漏关联仍需管理员部署后按步骤确认。** 保留工作区已有资料库 EXDEV 等改动，未提交或推送。本条验证仅覆盖本次 SYNC 与其定向回归，不追溯宣称此前未验证的资料库导入功能已通过验证。

## 2026-10-22 — SYNC 视觉请求超时恢复

- 原因：管理员提供 RICHRFID PDF 的转换失败截图，显示通用 timeout、10/11 次已记录用量。只读检查原 PDF：18 页 A4、未加密，按现有配置每页一幅 1191×1684 渲染图。旧视觉转换将单次请求与整体截止的中断直接向上传递，无法区分类型和定位页码，且单次偶发超时没有自动重试；截图与第 11 页中断吻合，但未独立读取 VPS 运行日志来确认当时的超时层级。
- 最小修改：本轮运行代码仅更改 `converter.ts` 与 Web 创建 SYNC converter 的配置。SYNC 视觉等待为 max(原 VISION_TIMEOUT_MS, 180000)，保留显式更大值，不修改共享聊天配置。视觉单次本地超时（含响应体读取）最多重试一次；每次重新获取/释放模型并发名额并计入原请求预算，单文件整体截止仍不变。停止操作、整体超时、HTTP/网络错误、识别不完整不自动重试，不跳页或放宽完整性校验。
- 报告与兼容性：错误区分 `Vision request timed out`、`SYNC file deadline exceeded` 和取消，附具体 page/region；单次超时附等待毫秒数/尝试次数/请求预算耗尽说明，自动重试记录到 coverage。成功区域缓存、SHA256 校验和转换版本 4 保留，不要求重新识别已成功内容。不改入库/索引/去重/发布流程，不新增依赖、env 或 systemd 项。部署后普通 Re-Sync 续跑，保持 Reconvert original 未勾选，反馈留空。
- 验证：Node **22.23.2** TypeScript 构建通过；timeout、vision、conversion、service、web 五个测试文件的 **46 项检查全部通过，无跳过**（含嵌套用例）。覆盖单次超时成功、两次超时停止、响应体中途超时、预算耗尽、总体截止、主动停止、排队截止、HTTP/网络/识别错误不重试、计数/并发释放与 Re-Sync 缓存复用；既有转换测试处理隔离生成的 PDF/Office/图片。
- 原文件验证：在系统临时目录用管理员提供的 18 页 PDF 进行真实本地渲染，接本机模拟视觉接口，并故意令第 11 页第一次请求超时；最终 18 页 rendered、18 区域 inspected、19 次请求、18 次模拟用量、第 11 页仅请求两次。原文件哈希未变，临时结果已删除，模拟转录没有进入正式知识库。**未调用真实模型、未执行全量测试、未修改正式知识/Memory 或 VPS，未提交/推送/部署。** 保留此前工作区所有改动，不能把本地模拟通过表述为 VPS 真实识别已成功。

## 2026-10-22 — SFTP 路径编辑与 systemd 定时设置

- 原因：管理员希望在 SFTP Run now 旁直接编辑已配置的 `sftp_sync_paths.jsonl` 和调整既有 systemd timer，并追加明确 Check，不允许错误列表保存。沿用既有账号/下载/去重状态，不新增自动知识 Sync 或企微推送。
- 路径编辑：Settings dialog 的 Paths 与 Schedule 分别保存。路径编辑器先点击 Check：仅 path 的逐行 JSONL、绝对安全路径/后缀、重复路径、非空及 4 MiB/10000 行限制，有错误列出行号，修改文字使先前检查失效，迟到的旧检查也不能启用新草稿的 Save。保存后台重新校验固定配置路径，按打开时 SHA256 防覆盖，原子写入，旧版本备份于 `logs/sftp_sync/path-backups/`；与 CLI/手动导入共用现有跨进程锁，导入过程中返回 409。原 CLI 的旧重复项去重/坏行报告规则保持；修改列表下次运行生效，无需重启。错误或冲突保留草稿，关闭未保存弹窗需确认，读取/检查中的过期响应不会覆盖重开的编辑器。
- 定时管理：真实 systemd timer 是唯一来源，显示启用/运行、北京时间 calendar 和下一触发。仅支持既有单一每日/每周 Asia/Shanghai 定时、有效 weekday/HH:MM 和启停。后台按版本保存，拒绝外部配置冲突；不支持/被 mask/带其他触发器的 timer 只读，不静默覆盖。写入专用 `90-web-schedule.conf` 并重置 OnCalendar，保留 Persistent 补跑，重载并核对实际启停/时间；不直接启动/停止 SFTP import service，也不取消当前导入。失败尝试恢复旧 drop-in/启用/运行状态并复核；恢复失败明确要求 VPS 排查，不假报成功。
- 权限与部署：新增 root-owned、仅 Node built-ins 的独立 schedule helper，通过固定 Unix socket 接受 status/save，固定目标 `product-expert-sftp.timer`、固定 drop-in，校验所有参数，不接受任意路径/单元/命令，无 shell。socket-activated 短任务由 flock 串行化，root-owned 代码安装到 `/usr/local/libexec`，不得改为 app-writable dist。新增 `.socket` / `@.service` 模板，默认 root:root 0600，匹配管理员当前 root Web；说明提供非 root 的受限 group 配置。需用户一次性在 VPS 安装/启用 helper socket，不替换现有 SFTP service/timer；无需 npm 新依赖、env 字段、通用 sudo 或放宽主服务 ProtectSystem。此后 helper 代码更新需重装其 root-owned 编译副本，文档已注明。
- API/UI：新增管理员 `GET/PUT /api/sftp-sync/settings/paths`、`POST .../paths/check`、`GET/PUT .../schedule`，严格字段白名单；沿用 Cookie/Origin/CSRF，WeCom/MCP 凭证无管理权限，不返回连接凭证。helper 不可用时只禁用定时编辑并提示安装/权限，路径/手动导入/聊天继续可用。Source imports 不再显示错误的“未启用任何定时”固定文案；定时摘要显示实际状态。README、SFTP 配置说明包括完整安装、更新、权限和排错命令。
- 验证：**Node 22.23.2** 构建与五个相关测试文件 **31 项检查全部通过、无跳过**（包含嵌套测试），覆盖 JSONL 校验/重复/限制/UTF-8/链接/存储失败、冲突和备份、导入锁、timer 日/周/暂停/只读情况、命令参数注入、回滚与回滚失败、Unix socket 协议及缺失 helper、管理员鉴权/CSRF/Origin、独立保存/旧检查竞态/关闭草稿，保留 SFTP 既有传输与恢复回归。timer 使用隔离文件和模拟 systemctl，不访问宿主 systemd。
- 浏览器：使用临时资料和模拟 timer 启动隔离 Web，真实浏览器完成登录、Settings 打开、错误 JSONL 行号/Save 禁用、修改后重检、有效保存、每周时间与暂停的独立保存，截图保存于 `/tmp/product-expert-sftp-settings-preview.png`；未使用真实 SFTP 凭证/连接或修改正式路径列表。临时 Web 与资料随后清理。移动端 CSS 已实现，未进行实际移动设备验收。
- 验证边界：宿主为 macOS；尝试在既有 Ubuntu 文件 worker 镜像做 systemd 静态检查，该镜像无 systemd-analyze，未宣称验证通过。依据官方 systemd 文档/255 源码核对 Unix socket、只读挂载下 IPC、timer 属性和 systemctl 管理调用；**未完成真实 Ubuntu socket activation、权限或 timer 应用验证，需 VPS 安装后确认。** 未运行全量测试、未调用真实模型/SFTP、未修改正式知识/Memory/env/VPS，未提交或推送。代码保留原 SYNC、Library imports 和 SFTP 行为。


## 2026-10-22 — Library imports 定时 Settings

- 原因：管理员希望 Library imports 的 Run now 旁也能调整定时时间，已确认 VPS 安装名为 `product-expert-library-import.timer` 与 `product-expert-sftp.timer`。沿用现有 systemd 管控，不改变导入判断/下载/去重或自动启动知识 SYNC。
- 实现：Library 独立 Settings dialog，只编辑每日/每周、weekday、北京时间和启用/暂停，显示实际 calendar/下一触发；支持 Reload、未保存提示，保存失败/版本冲突保留草稿，过期读取不覆盖重开的弹窗。使用现有 SFTP Settings 样式；定时摘要从真实 helper 状态读取，移除页面使用固定计划文案的逻辑。
- Helper：复用原 Unix socket、flock 和独立 root-owned 编译副本，通过固定 `sftp`/`library` 枚举选择两份明确 timer/service/drop-in；旧 SFTP 无 source 请求继续有效。未知 source、任意 unit/path/命令拒绝。两边复用既有校验、原子写入、daemon-reload、实际状态核对与失败回滚，各自只操作其 timer，不直接启动/停止 import service。Persistent 补跑保持，启用/重启时仍可能由 systemd 触发正常补跑。
- API 与权限：新增 `GET/PUT /api/library-import/settings/schedule`，后台绑定 Library 来源，HTTP 不接受目标来源参数；仅管理员 Cookie/Origin/CSRF，WeCom/MCP 凭证无管理权限，不暴露密钥。helper 模板只新增另一处固定 timer drop-in 写权限，主 Web 权限不变，无新依赖/env/socket/调度器。需用户构建并重新安装 root-owned helper 与更新模板，先创建两份固定 drop-in 目录，再 daemon-reload/重启 Web；不覆盖现有 import timer/service，不提交或部署。
- 验证：**Node 22.23.2** TypeScript 构建通过，七个定向测试文件 **36 项检查全部通过、无跳过**（含嵌套用例）。包含实际临时 Unix socket 的双来源路由、SFTP/Library 相互隔离、Library 日/周/暂停及失败回滚、未知来源/越权 unit 拒绝、管理员鉴权/CSRF/Origin/冲突、UI 草稿/失败/迟到读取，以及原 SFTP 路径、传输恢复和 SYNC HTTP 回归。systemctl 为隔离模拟；Library UI 执行真实脚本于最小 DOM，**不是本次真实浏览器视觉验证或 Ubuntu systemd 激活验证**。未运行全量测试、真实模型/资料库/SFTP 下载，未修改正式知识/Memory/env 或 VPS。保留此前所有工作区改动，README、Library/SFTP 说明同步提供更新步骤。

## 2026-10-23：企业微信在线资料定时导入

原因：将企业微信在线表格/文档的文字稳定导入现有收件流程，避免依赖个人电脑 MCP、重复消耗模型或人工反复导出；图片不作为知识来源。本轮延续管理员此前明确授权，在 ProductExpertCloud 实现，未修改 pi-patrick、patrick-agent 或 wecom-mcp 项目源码。

行为与兼容性：

- Source imports 新增 WeCom imports 的 Run now、Stop、Settings、历史/逐文档输出与读取覆盖；新增 `/api/wecom-import/*`，沿用管理员 Cookie、Origin、CSRF。Bridge/MCP 机器凭证不授予维护权限，无任意命令/路径/输出目录入口。前端所有远端名称、描述、错误作为文字展示。
- 独立清单 `.data/wecom_sync_docs.jsonl` 仅 `docid` + `description`，支持普通 `e3_` 表格和 `w3_` Word；智能表格/文档、幻灯片拒绝。Check、保存重检、打开版本冲突、旧清单备份、原子保存和已有 proper-lockfile 机制；清单保存与该导入器互斥，当前 run 使用启动时快照。为复用编辑器，仅给 SftpPathsEditor 增加默认不变的校验函数注入。
- 官方 CLI 只允许六个读取操作，明确隔离授权目录，子进程环境不继承 Bridge bot、外部 access token/header/debug 配置。有限重试、45 秒请求、10 分钟文档及两小时批次截止；POSIX 私有进程组停止官方 npm launcher 及 native 子进程。每工作簿 200 表/500,000 格，快照/单份 Markdown 16 MiB，写入保留 256 MiB 余量。权限失败逐文档记录，授权/磁盘失败停止剩余文档。
- 表格同成功版本跳过全文；版本变化时读取所有表（含隐藏表）、实际范围分块值/公式/文字链接与合并区域，拒绝截断/不可见/覆盖不符；前后版本变化最多重新完整采集一次。成功但省略空 merges 字段的 CLI 响应兼容为空，其他不完整响应失败。每表独立内容 Hash，排除图片、单元格样式、版本和抓取时间；真实合并才传播锚点，并保留来源行列、多行文字、数字/布尔类型和公式。稀疏跨行/列合并避免扩张无关空白的笛卡尔积，并有输出预算。
- Word 每次读取正文及可用版本，支持直接正文、限定请求目录内的正文文件/JSON 包装文件；规范化正文 Hash，不假设独立版本预检。忽略图片，不调用 AI；缺少真实 Word 样本，本轮只完成模拟协议验证。
- `.data/logs/wecom_sync/` 保存状态、成功快照、JSON/JSONL 报告。逐来源/工作表稳定文件名，改描述不触发内容更新，重命名保留文件名。比较最近成功 Hash，消费后不重复投递，A→B→A 仍作为真实更新。完整采集核验后在收件目录内隐藏暂存，避免 EXDEV；先落待投递记录再原子发布。旧收件副本须符合已管理 Hash 才替换；人工修改保留并报冲突。重启先恢复待投递，不能用版本未变绕过恢复；证据不充分则拒绝猜测。保留原 SYNC 输入 Hash 校验。移除来源/工作表只报告，不删除正式知识。
- 新增 `npm run wecom:import`，直接执行已有 dist；没有新增项目 npm 依赖，VPS 需单独安装/授权官方 CLI。`.env.example` 仅新增 CLI 路径、独立授权目录、清单路径及可选超时占位，不保存真实凭据。
- 新增独立 service/timer 模板：每天 04:00 Asia/Shanghai，Persistent 补一次漏跑，不依赖主 Web 服务，不自动启动知识 SYNC。既有 SFTP 命名 helper/socket 仅扩为三个固定 timer，分别读取/保存实际 systemd 状态、冲突校验/失败回滚。安装说明要求**先建三个 drop-in 目录再更新 helper**，防止此前 226/NAMESPACE；不覆盖现有 SFTP/Library service/timer。用户负责提交、VPS 更新、授权与安装启用。

验证：

- Node **22.23.2** 构建通过；最终 `node --test tests/*.test.mjs` **298 项通过，0 失败**。模拟覆盖清单 Check/冲突/备份/锁、版本跳过、样式/图片变化但文字未变、单表更新、隐藏/合并/多行/公式/数值、重命名/同名来源、内容恢复旧值、消费去重、截断/不可见/中途变版、授权/磁盘/取消、人工改动、真实 CLI 子进程与 Web 锁重叠、待投递重启恢复/硬链接中断/证据不足拒绝、损坏/符号链接、Word 正文及临时文件、进程组取消/限流重试、管理员访问边界、三个 timer 隔离。
- 隔离浏览器确认 Source imports 新入口、JSONL 错误禁止保存、有效 Check→保存、独立模拟计划保存以及 Run now/逐文档报告。前端自动化覆盖草稿保存失败、迟到 Check/读取、关闭未保存提示；systemctl 及计划保存是模拟，不能视为真实 VPS 成功。
- 使用已授权官方 CLI **1.2.1** 只读抓取 Device and Accessories Guide，前后版本 **14519**，全部 **38 张表**（隐藏 SR5600、i9100 非金版）、**4,065 个非空单元格**的值/类型/坐标及 **635 个实际合并区域**与管理员原始 XLSX 完全一致，零差异。隔离首次投递 38 份，第二次仅一次版本请求即 Unchanged；使用最终 Markdown 渲染器重新输出 38 份约 349 KB 的文字文件验证。证据/生成物位于本机临时目录，未修改原 Excel、在线内容、正式知识或 Memory，未执行正式 SYNC。
- Guide 的真实只读采集复用了本机已有授权；没有在 VPS 初始化或更改部署凭据。真实 Word、长期 token 自动刷新、Ubuntu systemd 激活/计划与沙箱权限尚未验证，留待管理员部署。未调用真实模型，未安装/启用定时器，未提交或推送。

## 2026-10-23：Source imports 子 Tab

原因：三个导入面板纵向堆叠，需要滚动到底部才能使用 WeCom；改为主导航下的 SFTP / Library / WeCom 三个子 Tab。

行为/兼容性：一次显示一个既有面板，默认 SFTP；`source` 查询参数保留刷新后的选择，非法值回退 SFTP。使用标准 tablist/tabpanel、选中状态与 roving tabindex，支持左右方向键及 Home/End。面板只隐藏，不重建，因此原有报告、Settings、草稿与导入/停止/后台轮询保持；不改导入器、配置、凭据、定时器或模型。Web 仅增加子 Tab 脚本静态资源映射，沿用代码更新/构建/重启主服务流程。

验证：Node 22.23.2 构建和新脚本语法检查通过，8 项既有报告/WeCom/Library 设置界面回归通过。隔离浏览器确认三个面板互斥显示、鼠标切换、Home/End、URL 更新及刷新后保留 WeCom；生成隔离界面截图。未执行真实导入、模型请求或 VPS 部署，本轮未新增测试文件或运行全量测试。


## 2026-10-23：WeCom 分表发布身份与旧整本迁移保护

原因：Guide 在线导入已生成 38 份分表 Markdown，旧 Excel 整本来源尚在；不能让模型仅凭文件名推断替换关系，也不能让每张配件表占用/替换已有独立产品 accessories。管理员确认保留分表事实、既有总入口改为导航、逐步退役旧整本的长期方案，本轮继续在已授权的 ProductExpertCloud 实现。

行为与兼容性：

- 新增隔离的 WeCom 来源组装/校验模块。仅对特定导入文件名读取成功 receipt/cache，核对正文 Hash、快照 Hash、docid/工作表身份与当前内容 Hash；兼容此前已生成的 38 份 Markdown，无需重新导入或重置状态。普通输入沿用既有转换/重复/关联流程。
- SYNC 以 docid + sheet ID 绑定 `_shared/<slot>/wecom-<摘要>_<时间>/<文件>.md`，只允许更新自身已发布前身，不覆盖旧整本、另一分表或产品本地配件资料；保留既有关联型号。改名保持身份，完全相同的已发布正文跳过模型发布。受管理来源不能通过通用 association-only 绕过绑定；新增覆盖须恢复可核验原件并带反馈重新 SYNC。
- 后台维护同一文档的共享导航、源链接、实际产品 Hub 回链及主目录入口，正文不经摘要/改写。源归属元数据存于导航的受管理注释，复用现有 source/Hub/index/log 发布 journal、基线校验和回滚，不另造第二份提交状态。Library 禁止编辑受管理导航，手工修改正文/导航、丢失绑定或伪造输入均明确失败。既有独立产品 accessories 保留。
- Git 忽略的 `.data/knowledge-sync/wecom-routing.json` 可明确接管既有 Guide 总入口、固定 accessories slot 和旧整本路径；错误旧路径拒绝，不自动匹配/覆盖既有共享页，不允许运行后静默移动整族。首次迁移保留旧总览和整本链接并标明兜底，未发布分表标 Pending Sync。删除旧整本必须独立 Delete knowledge 预览；预览与提交核验当前最新完整导入快照、所有预期分表的正文/语义 Hash，部分迁移、上游新文本未发布或待恢复投递均禁止退役。依赖/事实审查仍沿用原模型与后台规则，图片证据差异不能靠分表投递自动消除。
- 明确删除分表会记录 withdrawal，阻止自动恢复；恢复须准确的 `RESTORE WECOM <docid> <worksheet-id>` 指令、可核验输入和发布确认。上游移除仍只保留并提示复核，不自动删除知识。README、WeCom 导入说明和独立迁移步骤同步更新；没有修改 importer 的逐表变化检测、SFTP/Library 行为、凭据、依赖、环境或 timer/helper。

验证与交付边界：

- Node **22.23.2** TypeScript 构建通过；`node --test tests/*.test.mjs` **311 项通过、0 失败/跳过**。新增 13 项专项检查通过，并补跑相同专项核验 Duplicate 的无模型重复消费及拒绝 association-only 绕过。覆盖现有回执、单表更新/改名、占用 accessories、跨分表/整本误替换、部分/完整迁移、删除预览后上游变化、手工/恶意输入、错误 routing、事务中断回滚、Library 只读、withdrawal/显式恢复；真实 UTF-8 converter 核验正文不变，中文/空格/括号/符号路径编码可追踪引用。
- 使用此前真实只读 Guide 采集留下的隔离生成物，离线重新核验 **38 份正文/回执、38 个唯一工作表及完整清单**，全部兼容。本轮没有重新连接企业微信，也没有把离线重放宣称为新一次真实读取或真实模型结果。
- Planner、业务发布及恢复均使用隔离临时知识与模拟模型；未调用真实模型、未执行正式 SYNC、未修改正式知识/Memory/原 Excel/在线文档/VPS，未删除旧整本，未提交/推送/部署。真实模型的分表产品识别、迁移事实审查及 VPS 操作留待用户部署后确认。保留当前工作区既有 Source imports 子 Tab 改动；本任务不新增 UI 流程或重做浏览器验收。


## 2026-10-23：Memory Injection 直接编辑主/额外记忆

原因：管理员希望在现有对话框直接编辑两种记忆，并单独下载 Extra Memory，无需每次交给 AI 改写。本轮继续在此前已授权的 ProductExpertCloud 实现，未操作 pi-patrick 或 patrick-agent。

行为/兼容性：

- 原 Memory Injection 底部保留 Download Memory File，新增 Edit Memory、Edit Extra Memory、Download Extra Memory。共用独立编辑 dialog，显示固定目标文件、完整 Markdown、加载/保存/Unsaved changes；Save changes 才保存，不调用模型。关闭/Escape/Reload 保护草稿，保存冻结编辑/关闭，错误和冲突保留输入；读取迟到不覆盖另一次打开的文件。窄屏按钮换行，CRLF 编辑保留换行风格，不把加载后的换行规范化误判为修改。
- 主记忆固定 `memory/urovo-product-expert/MEMORY.md`，复用 MemoryInjectionService 互斥、知识写锁、格式校验与原子发布，旧文存到 `maintenance-backups/main-memory/manual-<UUID>.md`。编辑读取不校验条目格式，允许修复损坏但仍合法 UTF-8 的旧正文；保存必须非空白、合法 UTF-8/NUL-free、2 MiB 以内并符合既有记忆格式。原 AI 预览/附件/确认流程保持；主记忆直接保存后，UI 禁止继续确认当前旧预览，后端 Revision 校验也拒绝其他页面持有的旧预览。
- Extra 固定 `memory/urovo-product-expert/MEMORY_EXTRA.md`，缺失可读取为空，直接保存可首次创建或清空。新增整文件编辑入口与原 memory add/edit/delete 共用队列和原子 writer，保留原工具返回/备份格式及冲突时提供最新内容用于重新判断的行为。直接保存验证格式/重复 ID、UTF-8/NUL 和 2 MiB 上限，备份仍在 `maintenance-backups/extra-memory/`；未改工具原有单条 64,000 字符限制。沿用单进程写入边界，不宣称具有跨进程锁。普通快照和会话注入逻辑保持。
- 新增 `GET/PUT /api/memory-injection/files/main|extra`，GET 返回完整 text/Revision，PUT 仅接收 text/revision；固定目标，无路径/query 参数，冲突 409。新增 `/api/memory-injection/download-extra` 返回当前保存的原始字节，正确文件名 MEMORY_EXTRA.md；缺失为空下载，格式异常亦可导出，拒绝链接和超过 2 MiB 的文件。API 沿用管理员 Cookie、Origin、CSRF/no-store，Bridge/MCP 机器凭证没有管理权限。
- 两种记忆保存均在已有 session 的下一 run 生效，当前 run 快照不变。没有新增 npm 依赖、环境变量、timer/helper 或 systemd 修改；用户按原流程同步代码/构建/重启主服务并刷新即可，前提是原 Memory Injection 所需主记忆可写权限已就绪。README、Memory Injection、Synchronize 说明同步更新。

验证：

- Node **22.23.2** TypeScript 构建通过；全量 `node --test tests/*.test.mjs` **319 项通过、0 失败/跳过**。最终补回原工具迟到冲突的 revision/content 返回兼容后重建，主/Extra/Injection/新 UI 共 **19 项定向回归通过**。其中新增 5 项后端/HTTP 和 3 项 UI 检查，验证固定目标、格式/重复 ID/大小/NUL/UTF-8、BOM/CRLF 原文与备份、主/Extra 隔离、缺失/清空、并发工具与编辑器防覆盖、知识读锁等待、旧 AI 预览冲突、符号链接拒绝、下载原字节、登录/CSRF/Origin/机器凭证拒绝，以及草稿/迟到读取/错误下载/预览失效。
- 使用隔离临时资料和空模型配置启动 Web，真实浏览器完成两个编辑器打开、中文主记忆保存、Extra 坏格式拒绝后草稿保留、有效 Extra 保存、下载按钮点击、窄窗口按钮换行。HTTP 自动化核对下载内容/文件名/no-store；未把浏览器点击等同于人工确认下载落盘。截图为 `/tmp/product-expert-memory-buttons-preview.png` 和 `/tmp/product-expert-memory-editor-preview.png`。UI 自动化还验证未保存关闭/Reload 和迟到响应；未进行真实手机设备验收。
- 所有读写/模型协议验证使用隔离 fixtures 和模拟模型，未调用外部真实模型、未修改正式 Memory/知识/凭据/VPS，未提交/推送/部署。隔离预览服务与临时资料在交付前清理，截图保留供查看。


## 2026-10-23 Web 内存与重启登录优化

原因：管理员提供 VPS 日志，主服务在 16:39 与 16:53 连续触发 Node JS heap OOM（约 256 MiB），systemd 重启后内存会话丢失；当时机器仍有约 2.4 GiB 可用内存。本机发现报告轮询读取/structuredClone/发送整份历史差异、浏览器为折叠差异构建全文、每条 Token 回调在写队列前生成完整 JSON 的高内存路径。日志未证明所有内存来源均已排除。

行为与兼容性影响：

- 主 Web 模板改为 1024 MiB JS 堆，整组 MemoryHigh=2200M/MemoryMax=2600M、worker 上限与串行文件队列保持。新增 `deploy/product-expert-memory.conf`，管理员可只覆盖既有 VPS ExecStart，保留账号、硬化、timer 等配置；未安装、未重启 VPS。无新 npm 依赖或 env 字段。
- 管理员报告 `?view=summary` 只返回状态、用量、业务选项、差异路径/内容修订摘要及覆盖数量；单项详情展开时读取，旧历史报告串行解析且不 structuredClone 整份内容。不带查询参数的完整 API 保持兼容。浏览器轮询保留展开状态、关闭释放正文，修订变化需重新展开，详情拒绝过期 revision；既有正式报告 JSON、发布计划、事务与恢复格式不迁移。
- 高频用量保存按一秒窗口合并，序列化放到写入队列实际执行时，不积压完整 JSON 字符串。阶段、发布、错误、停止与关闭依旧等待原子保存，并刷新待保存计数。硬杀可能损失最近一秒用量，正式已提交事务恢复逻辑不变。
- 固定 `.data/web-auth/sessions.json` 保存至多128条 Cookie SHA256摘要/原过期时间、随机盐及 HMAC，由配置凭据派生签名密钥，0600原子写入，拒绝链接与坏结构。Cookie或凭据原文不落盘；退出持久撤销、七天固定到期、改账号/密码使旧签名失效。服务重启更换 CSRF，旧页面刷新即可继续；不放宽 Origin/CSRF，不自动重放保存。首次升级前仅在内存的 Cookie 需重新登录一次。

验证：Node 22.23.2 构建、328/328 全量本地检查通过，覆盖摘要/完整旧接口、详情修订冲突与管理员隔离、保存合并/定时/关键状态/关闭冲刷、登录跨重启/到期/撤销/改凭据/篡改/错误路径/并发/写失败、既有 SYNC 发布恢复及三类导入。旧测试关于“重启使 Cookie 失效”的断言按新规格更新。隔离真实浏览器验证初始折叠不含正文、展开差异和覆盖检查、服务重启后无需再登录；截图 `.data/debug/optimization-report-preview.png`。未访问/修改 VPS、未调用真实模型、未执行正式 SYNC。

合成压测：`scripts/profile-sync-reports.mjs` 在隔离目录生成12项约26.9MB报告、两个独立1024MiB堆进程各进行64次/4路并发读取。完整接口响应26,934,839bytes、峰值RSS1369MiB；摘要7,715bytes、峰值RSS190MiB。结果 `.data/debug/report-profile.json`。为本机读取/序列化压力对照，不是 VPS或真实模型/原生转换的内存保证。显式展开旧大报告仍需一次完整JSON解析，完整旧API仍可能产生较大峰值；部署后需观察实际日志。


## 2026-10-23 SYNC 文本 Agent 错误终止与成功结束修复

原因：管理员退役旧整本的预览累计15,677,510输入Token、64/65请求后失败，却显示“必须走删除预览”。此前本机模拟确认：SDK预算错误被转换为assistant错误消息，planner又用此前被拒绝的decision兜底，后续校验覆盖真实终止原因；有效finish也会额外请求一次结束语。用户仅授权本项修复，不实施退役前置流程、上下文裁剪或费用统计改造。

行为与兼容性影响：

- 只有完整读取及既有buildPlan/validate通过后才保存有效decision。删除rejected fallback；模型预算、HTTP/流错误和输出截断分别保留真实原因。用户停止/超时以原AbortSignal为准，不被此前失败方案覆盖；无finish_sync的普通文本仍明确失败。
- 使用现有SDK的shouldStopAfterTurn及工具terminate机制正常结束，非内部假报错或取消伪装成功。维护工具批次显式串行，完成后同批后续工具不再执行候选写入。成功/业务review仍返回原结构；删除保留预览→确认→事务提交。
- 相同finish问题集合（忽略顺序）连续两次，或总计三次拒绝，终止并保留实际错误；完整读取守卫和schema失败纳入。其他工具连续两次完全相同错误也停止。允许在预算内修复有效问题后正常成功，不返回未通过校验的候选。
- SYNC独立内存会话关闭SDK自动网络重试，接口错误直接暴露经既有后端脱敏/限长后的原因；普通聊天与视觉转换重试不变。请求预算不提高；先检查上限再计数，未发送的第65次不会再使计数多一。旧报告不重算，env/systemd/持久格式/依赖无变化。
- 原有测试曾把最后仍被拒绝的add当作planner成功；现改为允许业务review在修复后正常结束，并新增真正发布/删除以及WeCom整本退役成功路径，避免仅修改断言掩盖回归。

验证：Node22.23.2构建、29项定向与最终343/343全量本地检查通过。真实SDK连接本地模拟HTTP接口，覆盖合法新增实际发布、合法删除预览与确认、WeCom两分表夹具全部迁移后纠正错误review→delete并成功退役且保留新来源、完成后不追加模型请求/不执行同批后续写入、重复/不同校验、参数/完整读取、HTTP400/402/429/500、错误后预算耗尽/取消、输出截断及用量计数。全量日志 `.data/debug/sync-cost-investigation/termination-full-final.log`。未调用真实模型、未执行正式知识库删除、未提交或部署VPS；生产大整本能否在64次内完成仍取决于合法方案和业务数据，不以模拟通过冒充正式成功。

全量初检还触发一个既有Memory测试的不稳定断言：以子串mem_b判断条目已删除，会误中随机新增的mem_b…ID。仅改测试为解析后精确比较id，未改Memory运行代码；单独7项复查及上述最终全量通过。

## 2026-10-23 Web 标签页 Patrick favicon

- 原因：管理员要求将提供的 Patrick 图片用作 Web 标签页图标。
- 行为：原图片按字节保存在 `resources/web/favicon.png`，四个 HTML 页面声明同一版本化 favicon URL；新增 `/favicon.png` 与浏览器默认 `/favicon.ico` 固定静态入口，均返回 `image/png`。登录前可 GET/HEAD，图标独立缓存一天；不改变页面内 Product Expert 标识、API 权限、依赖或环境配置。
- 验证：Node 22.23.2 TypeScript 构建通过；3 项既有静态资源/匿名访问/页面回归通过。隔离临时服务核对四页声明、匿名 PNG/ICO GET 的 MIME/缓存/原图字节一致性、HEAD 空响应和受保护 API 仍为 401；未调用模型、修改正式业务数据或部署 VPS。

## 2026-10-23 删除 Agent 分批读取与完整缺漏清单

- 原因：旧整本删除预览在多次模型请求后，因共享总入口原文未完整读取而失败。此前错误终止修复能保留真实原因，但逐文件/offset 的自行读取仍容易遗漏。
- 行为：只在删除会话提供 `read_next_deletion_batch`，通过既有 `source_dependents` 登记明确目标和直接引用页；请求正文也纳入。沿用原快照与20000字符读取记录，每批最多4段/40000字符，已读段自动跳过，空队列重复调用不重读。提交时汇总全部缺失原文分段，含未读的声明 reviewedPaths/已有暂存修改页，返回路径、offset 和继续读取工具；所有缺失项同步加入队列，未完整补读不接受提交。读取候选稿不计为读取原文；日志自动维护与受保护路径不进入批量正文。
- 边界/兼容：仅修改维护 Agent 的运行逻辑与指令；普通 SYNC 不提供此工具、原 source_dependents 响应形状保持兼容。清单仅驻留本次会话，不写状态或正式文件、不授权删除；不新增迁移预检，不裁剪机器元数据，不修改导入器、业务数据、哈希、来源验证、发布事务、管理员确认、既有请求及重复失败上限。无新依赖、API、env或systemd配置。仍由管理员同步部署。
- 验证：Node 22.23.2 构建、32项定向和346项全量检查通过；最终进一步改用批量工具的 WeCom 两表退役模拟单项复核通过。覆盖中文大文本、多文件/多段上限、混合已读 offset、一次完整缺漏清单、动态补入声明页面、原文/候选稿区分、间接引用不扩散、重复空读、受保护/缺失目标、取消、正常SYNC隔离；服务模拟确认预览前后原件保留、确认后删除且独立规格仍在。WeCom 模拟覆盖既有拒绝后补读并接受删除计划，发布后保留全部分表、索引及独立配件。测试的本地 HTTP 模型替身改为拼接 Buffer 后解码，避免大中文请求跨网络分片的UTF-8测试失真，不涉及生产HTTP读取修改。
- 范围说明：未调用付费模型、读取/校验 VPS 的38表发布状态、执行真实删除或部署。346项全量后仅调整WeCom模拟脚本使用新工具及补读流程，并单独复核通过；不宣称真实模型一次成功或具体Token节省比例。

## 2026-10-23 SYNC 精确局部替换反馈优化

- 原因：管理员删除预览在43次请求后因 `Each replacement must match exactly once` 失败，旧工具无法说明目标文件、哪项替换、零匹配还是重复匹配，也未明确已暂存页面必须读取 candidate 视图。此次只改进反馈与修复指引，不扩大替换权限或调整预算。
- 行为：`patch_candidate` 的哈希冲突/缺失文件/零匹配/多匹配返回 JSON 工具错误，保留原错误关键词；提供路径、1-based replacementIndex、当前 original/candidate 视图与哈希、nextRead 参数及最多8处字符 offset/行列/readOffset，并标记是否省略其余位置。匹配次数含重叠出现，保持唯一性限制。定位不复制整页正文，不切分整页创建大行数组；按已有20000字符分段指引补读。
- 原子性/兼容：多项替换继续按顺序在临时字符串上执行，全部通过才暂存；失败不保存其中任何一项。第2项及以后诊断明确是早先替换后的临时文本，给出的 currentHash 仍是未变的当前候选基线，要求修复并重交整批。将原 stage 路径检查复用于 patch 的入口，受保护路径、日志自动维护、关联只读模式和非Vault来源在正文/哈希诊断前拒绝。返回成功形状、精确字节匹配、哈希/大小限制、重复错误终止、读取守卫、删除预览/确认、发布事务均不放宽；不新增模糊/global替换、自动重试、API、依赖、环境配置或持久化格式。
- 验证：Node22.23.2构建、42项定向及最终356/356全量检查通过。新增本地HTTP模型替身覆盖中文零匹配/12次重复的截断位置列表/重叠匹配、缺失文件、旧哈希、候选与原文区分、20000字符以后的定位和精确修复、多项替换失败无部分保存、相同错误两次停止及受保护路径不泄露正文/哈希。真实SyncService隔离夹具经过错误patch→读取正确版本→唯一匹配修复→删除预览→显式确认，确认前原件和Hub未变，确认后只删除指定源并保留独立规格与事实，完成后没有额外推理。未调用付费模型、连接VPS、处理正式知识或执行生产删除。
- 检查说明：首轮全量中既有报告定时写入检查曾读到100而非101；未修改其实现或测试，单项复查与最终全量均通过。日志分别为 `.data/debug/patch-feedback-targeted.log`、`patch-feedback-report-timer-recheck.log`、`patch-feedback-full-final.log`。模拟成功不代表真实模型一定一次成功，也不承诺Token节省比例。

## 2026-10-23 WeCom 首次 SYNC 中文标题空值碰撞修复

- 原因：VPS 两份“POS项目清单/PDA项目清单”在模型调用前被错误归为 needs_review，提示接管 `shared/printer-consumables-knowledge.md`。只读调查确认，实际在线标题“（对外）项目对应各部门关系表”和已有页“打印机知识点（耗材）”都被 ASCII-only 归一化清空，空字符串相等导致误判；本机可复现。此前调查仅查询报告/标题，无业务修改。
- 行为：比较键保留 Unicode 字母和数字，继续忽略大小写/空白/标点；只允许非空标题键参与同名匹配。真正同名的中文/英文共享总入口仍要求原有显式接管配置。默认 docid 哈希索引、section 身份、既有映射/总入口、源哈希、退役与发布保护不变；不修改 routing、业务文件或历史报告，也不新增自动接管/迁移。运行代码仅改变 `knowledge-sync/wecom-sources.ts` 的归一化和空键判断。
- 验证：Node22.23.2构建、38项相关与359/359全量本地检查通过。新增3项回归覆盖实际无关中文标题、混合POS/PDA标题区分、同docid分表保持同一默认入口、真正中文/英文同名及标点/大小写等价仍受保护、Unicode数字、空/纯符号/无标题页面不碰撞。既有可信导入、单表更新、映射接管、跨来源拒绝、整本退役、事务回滚和导入器检查通过。日志 `.data/debug/wecom-title-targeted.log` 与 `wecom-title-full.log`。
- 部署/验证边界：本轮未连接或部署VPS、未调用付费模型、未执行正式SYNC。管理员同步代码并build/重启后，对原两条Re-Sync即可，不必修改映射、填写额外指令或重新转换；后续真实业务判断仍由原流程处理。

## 2026-10-23 WeCom 分类白名单与文本读取参数反馈修复

- 原因：管理员提供的POS/PDA项目清单再次失败。只读VPS报告确认：POS使用 `project-matrix` 后，原错误把不支持的slot插进了“必须使用”的路径提示；PDA报 `Use the supplied nextOffset`，没有附可执行的修复参数。报告未保留逐工具轨迹，不能声称已知模型实际提交的offset或全部调用顺序。
- 分类行为：VERIFIED WECOM SECTION增加六种allowedSlots，保持原 accessories/specs/brochure/presentation/user_guide/others 白名单。未知slot单独明确拒绝并列出允许值，不再用未知值构造必需路径；已注册文档族的slot不符单独报告，合法slot下仍执行原docid/section命名空间和路径格式校验。Prompt说明未适合其他五类的文档可选others，不新增project-matrix等分类、不自动更改映射/来源路径或迁移已发布文档。
- 读取行为：read_knowledge、read_candidate_source、read_batch_source保留20000字符分段和原始哈希/覆盖记录。非法分段或正文范围外的非零offset返回JSON工具错误，包含requestedOffset、正文长度、同一视图第一未读offset及可直接调用的nextRead.tool/args；已经读完则明确complete=true、nextRead=null。原文/候选/同批ID通过调用方显式保留，不依赖路径前缀猜测。非法请求不登记覆盖、不自动读写、不跳过完整读取或扩充模型预算。列表/搜索分页单位不变。
- 兼容性：运行只改knowledge-sync/agent.ts和wecom-sources.ts。成功读取返回形状、来源归属、内容Hash、模型重复错误终止、三次提交上限、发布事务和管理员确认保持；无新API、依赖、env或systemd配置。本轮未修改SFTP/Library、业务文件或VPS运行配置。
- 验证：Node22.23.2构建、54项定向及368/368全量检查通过。真实SDK对本地HTTP模型替身：首次WeCom资料收到白名单，project-matrix被明确拒绝，改为others及合法共享路径后接受；已注册accessories族不能改为others。正常SYNC大中文正文在非法/越界offset后按精确参数补读成功提交；原文、候选和同批文件身份分别保留，已读完不发明下一段。既有中文标题、哈希/命名空间、分表发布、删除预览/确认与事务恢复等回归通过。日志 `.data/debug/wecom-slot-offset-targeted.log`、`wecom-slot-offset-full.log`。
- 范围：仅真实VPS报告只读调查；实现验证未调用付费模型、重跑生产SYNC或部署代码。模拟成功不保证真实模型一次完成；未以放宽校验换取成功。

## 2026-10-23 共享来源产品识别修复

- 原因：CTA&SRRC报告要求“新产品授权”，此前只读VPS检查发现DT510已有产品Hub与已发布共享配件来源，却没有产品本地目录；后端仅按本地目录判断新产品，漏认这类现有产品。当前失败方案未完整持久化，不将DT510称为该次方案唯一可能的问题。
- 行为：新增/更新校验同时认可原知识库中按既有resolveHub规则解析的产品Hub。已有同名或唯一大小写/空格/标点对应Hub时，即使全部来源位于_shared，也无需新产品授权；仍须维护相应Hub和共享回链。真正新产品继续要求管理员反馈，错误保留原前缀并附具体型号。Prompt明确共享来源场景。
- 边界：仅以原始base识别，暂存新Hub或选择其他现有Hub不能绕过授权；歧义Hub不自动选取。保留原产品本地来源识别、非同名Hub确认、路径/来源归属/读取/哈希/发布事务及预算。无新增接口、依赖、持久化、环境或VPS配置，不修改正式知识或历史报告。
- 验证：Node22.23.2构建、81项相关及371/371全量本地检查通过，git diff --check通过。新增隔离SyncService回归验证DT510只有共享资料、规范/大小写对应Hub两种情况下，无反馈正常发布新增共享认证，保留原共享配件和其他产品/索引；新增授权回归覆盖暂存新Hub、任意另选Hub及歧义Hub不能免授权，显式反馈仍可授权真正新产品。日志 `.data/debug/shared-only-product-targeted.log`、`shared-only-product-full.log`。新增验证使用本地夹具规划器，未调用付费模型、重跑生产SYNC、提交或部署VPS；不承诺真实模型一次完成。

## 2026-10-24 缺失知识页读取反馈与重复错误识别

- 原因：管理员提供的MDM springdel分表在4次模型请求后以`Not found.`失败。此前只读调查确认输入/转换正文一致且保留，代码的read_knowledge对缺失原文或尚未生成的候选稿都只返回同一句错误；不同读取目标可能被原连续失败规则混同。报告未保留工具参数，不能断言该次实际读错的路径或视图。
- 行为：read_knowledge在原有相对路径/受保护路径检查后，返回KNOWLEDGE_NOT_FOUND结构化错误，包含path、requestedView、requestedOffset、originalExists/candidateExists。原文存在但没有候选稿时，nextRead指引读取原文；两者皆无时，nextTools提供同名搜索和从头分页列表参数，并提示通过product_hubs解析Hub、通过read_candidate_source读取输入。只提供修复指引，不自动查找、读写、创建页面或以技术问题代替业务判断。
- 终止规则：仅此类缺失页错误改为按工具/路径/请求视图/错误类型比较连续失败；不同路径或视图不会混同，同一目标变换offset、显式false与缺省原文仍视为同一错误，连续两次仍停止。成功工具调用继续重置连续错误；其他错误、finish_sync拒绝上限、64次请求预算和成功后立即结束保持原逻辑。
- 边界/兼容：运行仅修改knowledge-sync/agent.ts，成功读取响应和原文优先/缺省读取新暂存页的兼容行为不变；缺失读取不登记完整覆盖。受保护/非法路径在存在状态诊断前拒绝，不泄露正文、哈希或存在状态。不放宽来源归属、分类、版本、原文完整读取、发布事务、删除预览与确认；不改业务数据、持久化格式、接口、依赖、env或VPS配置。
- 验证：Node22.23.2构建、86项定向检查及最终377/377全量本地检查通过，git diff --check通过。真实SDK连接本地HTTP模型替身，隔离SyncService覆盖多个缺失路径/视图→搜索→Hub解析→误读候选稿后按nextRead读原文→暂存→实际发布，原独立资料保留且不生成猜测页面；另覆盖同目标变换offset停止、单次串行工具批次内相同/不同目标、成功读后重置、不同缺失目标仍耗尽既有总预算、默认原文/已暂存视图、错误及候选稿读取不能冒充原文覆盖、受保护/非法路径无存在状态泄露。日志 `.data/debug/knowledge-missing-targeted.log`、`knowledge-missing-full.log`。定向86项后新增的同批次终止用例纳入最终377项全量；未调用付费模型、重跑正式SYNC、执行生产删除、提交或部署VPS，不以本地模拟成功承诺真实模型一次成功。

## 2026-10-24 普通SYNC完整缺漏清单与分批补读

- 原因：管理员的PDA屏幕配置分表在22次请求后因RT40S原文未完整读取而失败。此前只读VPS调查确认输入/转换一致，RT40S Hub为27777字符，需读取0/20000两段；报告未保留读取轨迹，不能断言具体漏段或是否误读候选稿。管理员明确只修此次普通SYNC漏读问题，不重构、不更改预算或失败次数。
- 行为：普通SYNC非review提交在原必读范围（输入正文、oldPaths、reviewedPaths、已有暂存页及关联模式必需来源/Hub）一次返回所有缺失原文段和offset，附nextTool=read_next_sync_batch。新工具只读本次提交登记的原始快照，每批最多4段/40000字符，跳过已读段；候选稿读取不冒充原文。首次登记前/读完后返回空队列，再次缺漏提交按当前范围重建清单，不发现或扩散到无关页面。补齐后仍重新走完整读取与原业务/来源/发布校验。
- 边界/兼容：运行仅在knowledge-sync/agent.ts为普通SYNC新增会话内清单、工具及提交反馈；删除分支、原删除工具及其行为不改。继续调用同一rejectPlan，缺漏提交照常计失败：连续两次相同问题或累计三次拒绝即停；64次请求预算、取消、成功后立即终止保持。不改导入器、普通问答、持久化格式、HTTP接口、正式发布事务、来源归属/版本/哈希或删除确认，不增加依赖/env/VPS配置。受保护路径及日志不进入批读，原保护与最终校验保留；未自动修复或扩大业务授权。
- 验证：Node22.23.2构建、64项定向及381/381全量本地检查通过，git diff --check通过。真实SDK连接本地HTTP模型替身，隔离SyncService模拟RT40S多段Hub、另一Hub、三段目录和多段中文输入：一次返回全部缺漏，候选尾段不能替代原文尾段，按边界多批读取后实际发布，发布前正式文件不变，保留独立规格与无关产品；重复空读不重读。另覆盖同问题两次停止、部分进展仍受三次总拒绝限制、补读仍受原请求预算约束、重建当前声明范围、保护/日志不泄露、取消与删除工具隔离；更新模式补读旧来源后仍拒绝未清理的依赖引用，修复引用才接受。日志 `.data/debug/sync-missing-batch-targeted.log`、`sync-missing-batch-full.log`。未调用付费模型、重跑生产SYNC、修改正式知识、提交或部署VPS；本地模拟通过不保证真实模型一次完成。


## 2026-10-24：WeCom 欢迎语、独立角色与会话清空

- 原因：恢复机器人私聊进入提示，允许用户随时设置AI角色/回答风格，以及独立清空当前上下文；群聊作为独立使用者，不能把个人偏好写入全局记忆。
- 行为：Bridge监听enter_chat/replyWelcome，命令无模型调用；/role前缀显示三个示例与当前原文，发起者下一条纯文本原样替换，设置流程支持取消与清除，群内可通过新的/role接管。/clear前缀及旧/new、新建对话停止旧任务、取消排队/待投递及待处理附件，切换空白会话，旧历史按原保留规则归档。范围版本防迟到回复与文件，角色与设置状态/命令进度重启保留。
- 接口/存储：新增Bridge专用GET/PUT/DELETE /api/wecom/role及scope三元组校验；后端roles.json为0600原子文件，校验链接/格式/大小，独立于会话。System仅企微run按已有发送者身份选择角色，每轮快照放在Extra MEMORY之后的User Role & Style末尾段；普通Web/MCP默认不注入，拒绝请求直接提供角色。旧Bridge状态无scopes字段可继续读取，无新增依赖/env或systemd配置。
- 边界：不变更公共记忆、知识库、现有工具权限或账号；不删除企微客户端历史气泡。保留机器人/群/用户隔离与既有消息去重/投递恢复；平台欢迎语频率由企微决定。未调用真实机器人/付费模型，未操作VPS生产服务或维护正式业务数据。
- 验证：本机Node v25.6.0类型检查、构建、JS语法及git diff --check通过；最终串行完整回归396/396通过（零跳过）。覆盖真实SDK请求/工具循环、System尾部与轮内快照、Web/MCP隔离、真实后端+Bridge空白会话与归档、慢媒体/迟到投递、重启/失败重试和命令前缀。首次并行检查的新增夹具断言与既有CLI时序失败已分别修正夹具、通过串行复验；未修改导入实现。本次未调用付费模型、真实企微或部署VPS，不宣称生产联调已验收。详细记录见 [开发记录](../dev-history/2026-10-24-wecom-role-clear.md)。


## 2026-10-24：隐藏欢迎语命令 /welcome

- 原因：管理员暂不方便通过企微首次进入事件检查欢迎语，需要可随时手动触发的入口。
- 行为：Bridge在普通问答/角色输入/附件处理之前识别/welcome前缀，忽略尾随文字，私聊和群聊均通过普通消息回复当前同一份WELCOME文案。命令不显示在欢迎语中，不调用模型或后端角色接口，不创建/清空会话，不改变现有角色、待处理附件、范围版本及角色输入者；沿用原消息去重和可靠投递。不修改自动enter_chat/replyWelcome链路，不新增依赖、配置或后端接口。
- 验证：本机Node v25.6.0下Bridge定向测试19/19通过（包含本次新增2项），两个变更JS文件语法检查及git diff --check通过。覆盖任意尾随文字、私聊/群聊、隐藏菜单、重复回调、无模型/后端调用和无新会话，以及既有角色、附件、输入流程与混合消息兼容。本次仅修改Bridge行为与文档，未重复全量Core测试；没有连接真实企微、调用付费模型或部署/重启VPS服务。手动回复验证欢迎文案，不替代平台自动进入事件验收。

## 2026-10-24 普通SYNC后台控制的原文读取阶段

- 原因：RoadMap“更新日志”在新补读工具已部署后仍因UPad offset 20000缺失停止。此前只读VPS调查确认输入360字符且转换一致，新代码和指令已生效；原实现依赖模型主动调用补读工具，且缺漏提交仍消耗拒绝次数。报告没有逐工具轨迹，不能宣称知道该次工具序列或具体触发第二次相同/第三次总拒绝。管理员本次授权将缺漏处理前置为后台读取阶段，保留发布校验与预算。
- 行为：仅普通SYNC的非review提交发现缺失原文时暂缓方案校验，并立即在工具响应中返回首批原文，标记submitted=false及reading/review_required。后续工具调用在该阶段继续推进原有4段/40000字符上限的只读批次；其他请求明确requestedToolExecuted=false，不执行写入、patch或提交。仍只读本次已声明必需范围的原始快照，不读候选稿、不扫描额外页面；返回requiredReads、已供应segments和剩余missingReads。
- 防止旧方案获批：即使最后一批已经读齐，当前助手消息中预先生成的后续工具请求也继续暂缓。只有在原有onPayload开始新的模型请求时才退出读取阶段，模型须看到原文后重新审阅、修订并显式提交。原方案未存为待自动执行的决定；模型结束却未重新提交、接口错误、预算耗尽或取消均不能回退接受旧方案。响应明确源文本不构成指令，缺失读取保持原文/候选稿分离。
- 兼容性与历史说明：本节变更了前一节“缺漏提交照常计失败”的行为——缺漏现在进入方案校验前的读取阶段，不调用rejectPlan。真正业务/路径/来源等校验失败仍按连续两次相同或累计三次终止，之前失败计数不清零；64次请求预算、超时/取消、成功后立即结束、来源/哈希/版本校验、确认和发布事务不变。运行仅修改knowledge-sync/agent.ts；复用普通SYNC原批读实现，删除工具与删除分支不改。未改模型供应商接口、SDK、依赖、HTTP接口、持久化、env/VPS配置或其他业务流程。
- 验证：Node22.23.2构建、128项SYNC定向和当前工作树401/401串行全量本地检查通过（零跳过），git diff --check通过。真实SDK对本地HTTP模型替身覆盖超过三批时模型连续finish仍由后台读齐、每批大小/Hash/去重/原快照、UPad尾段自动交付、同一助手工具批次的write/patch/旧finish/受保护读取均不执行，下一次模型请求后仅新提交获批；不重新提交与HTTP402不能接受旧方案，取消和预算仍停止。保留真实SyncService多Hub补读后实际发布、更新依赖未清理仍拒绝、保护/日志不泄露、关联模式只读及WeCom非法slot在补读后仍拒绝、删除预览/确认和退役回归。
- 范围与记录：旧用例按新读取阶段反馈更新，保留真实业务拒绝次数测试并新增跨补读阶段不重置计数检查；本地模拟不能等同真实模型一次成功。日志 `.data/debug/sync-read-phase-targeted.log`、`sync-read-phase-full.log`。全量基于包含原有未提交企微角色/欢迎语功能的当前工作树，本轮未修改其运行文件；保留其他工作树变更。未调用付费模型、连接或部署VPS、重跑生产SYNC、修改正式知识、提交代码或执行真实删除。


## 2026-10-24 行业研究业务背景与真实模型试刊

- 原因：先验证熟悉UROVO产品及use case的现有Agent能否研究过去一周的行业资讯，并提供有依据的简短销售参考；用户同意保存业务理解，暂不建立新闻Space。
- 数据与行为：本机形成业务背景和研究流程，保存于Git忽略的.data/research/；以现有AgentRuntime/Pi SDK、真实deepseek-flash和search/fetch执行隔离研究，不用Codex检索结果冒充Agent执行。旧位置记忆仅复制到隔离副本的新布局，未迁移或改写正式数据。
- 验证：北京时间10月17日至23日窗口，首轮约5分31秒、23次模型网络请求、16次搜索、18次网页读取尝试，8次工具错误；10次HTTP200中2次仅标题，实际8份实质正文，产出8条初稿。人工指出来源归属、未支持数字、兼容性/价格外推和调用计数问题后，同一Agent无工具修订为7条；Codex再补充三条销售参考的产品名称。保留原稿、修订稿和完整审计。详见dev-history/2026-10-24-industry-research-pilot.md，本机评价文件记录局限。
- 兼容与边界：未修改src/resources应用运行源码、正式知识/额外记忆、已有会话、生产配置或VPS；没有新增生产入口、研究数据库、自动调度或外部推送。业务背景尚未自动接入正式Web/WeCom任务。现有项目构建、脚本语法与git diff --check通过；无应用源码变化，未跑全量自动回归。本次真实研究不是模拟，但也不代表独立事实/产品兼容性核验或可靠全自动发布已验收。


## 2026-10-24 公司级 WeCom 来源与当前管理员回答

- 原因：POS认证「其他」分表包含公司级资质，管理员明确不归属产品、不修改产品Hub，但通用发布校验强制products非空、受管索引也拒绝空产品，技术限制被模型转为反复业务询问。同时历次允许/撤回回答直接拼成一段，没有本轮与历史之分。
- 行为：Decision可显式声明sourceScope=organization；仅已验证WeCom的others共享来源允许products=[]、hubs=[]，首发须有本轮管理员反馈，后续更新可沿用已注册公司级范围。受管索引显示公司级、无产品适用性，后台仍生成来源/入口/目录链接。普通输入、关联模式、其他slot不适用；已有产品关联不可丢失，产品Hub不可在此模式修改，旧整本退役校验不放宽。后续仅注册过的公司级来源可用无产品删除预览，仍审阅依赖并等待管理员确认。
- 反馈与兼容：累积feedback及历史attempts原样保留供审计，新可选currentFeedback保存本次明确回答；模型输入将current/history分开，同一问题按当前决定处理，保留未被改变的其他限制，技术失败不可冒充业务问题。空白重试沿用最后明确提交；旧报告没有新字段时按attempts的精确累积前缀恢复，不解析自然语言、不推定发布意图、不修改旧记录。验证只使用当前回答作为本轮授权文本，不用历史选项代替新的授权。HTTP/Re-Sync参数、确认按钮及发布事务不变；索引旧成员不加字段、不改渲染，新公司级成员带显式范围标记，旧程序不支持读取新公司级成员，需配套更新运行代码。
- 验证：本机Node22.23.2构建、132项SYNC串行定向与405/405项串行全量检查通过（零跳过）；全量后补充previousSourceScope到模型元数据及对应提示，重新构建并跑最终70项来源/结束行为定向，全部通过。覆盖真实SyncService的首发、重启、旧格式反馈恢复、空重试、转换缓存复用、公司级实际写入与删除预览/确认，以及已注册范围更新、索引重读、产品Hub/旧整本不变。拒绝无反馈首发、普通输入冒充公司级、错误slot/产品本地路径、产品Hub改动、丢失已有产品关联、伪造索引及未完成迁移退役；真实SDK对本地HTTP模型替身验证finish_sync字段、current/history输入和成功后立即结束。git diff --check通过。未调用真实模型；本地模拟不能保证真实模型每次一次成功。日志为.data/debug/sync-organization-sync-suite.log、sync-organization-full.log与sync-organization-final-targeted.log。
- 范围：仅知识同步的决策类型、反馈传递、校验与受管索引及提示词文档，不重构其他业务；未提交/部署代码、未调用付费模型、未重跑生产SYNC或修改正式知识数据。保留本轮开始前的行业研究记录变更。


## 2026-10-24 Web测试环境隔离

- 原因：用户VPS全量检查出现管理员缺配置用例30秒超时、WeCom清单数量13而非1。后者在本机用13条临时外部JSONL并设置WECOM_IMPORT_DOCS_FILE精确复现；管理员用例漏传dataDir，AGENT_DATA_DIR会覆盖其临时cwd，本机以外部哨兵文件复现误用该路径的ENOTDIR。未直接复现VPS原30秒超时，因此不把路径泄漏当作其唯一已确认原因。
- 修改：仅tests/web.test.mjs与tests/wecom-import-web.test.mjs。缺管理员配置场景显式传临时dataDir并关闭模型，保留三种缺配置与401/503检查；加入错误外部数据路径哨兵，防止以后重新继承宿主目录。企微Web用例在自己的测试进程临时绑定WECOM_IMPORT_DOCS_FILE/WECOM_CLI_CONFIG_DIR，结束恢复，另校验状态返回的docsFile等于fixture路径，继续执行实际清单保存、冲突、权限、run/stop和定时接口断言。
- 验证：模拟VPS环境覆盖的两个失败点修复后分别通过，原外部清单、数据与授权哨兵文件字节不变；临时复现目录已清理。缺管理员配置测试本机约121ms，企微路由用例约692ms。Node22.23.2构建通过，使用默认并发的node --test tests/*.test.mjs全量405/405通过，零跳过，约33.9秒；git diff --check通过。日志.data/debug/web-env-before-*.log、web-env-after-*.log与web-env-isolation-full.log。VPS原30秒超时仍需在那里更新后复跑确认。
- 兼容与范围：未改运行代码、业务校验、30秒测试超时或测试并发配置；未读取/修改VPS正式清单和数据、未修改.env/systemd、未调用付费模型或部署。不会通过把13改成预期值或跳过断言来掩盖隔离问题。


## 2026-10-25：独立行业研究模块与每日情报库

- 原因：将已有产品知识用于持续行业研究，产出可追溯的销售参考，并支持按任意截止日查询十四天内容。
- 行为：新增独立研究 System/Skill、业务背景、研究员/审核员运行器与只读知识工具；管理员 Web 入口提供启动、进度、收尾、每日场景、详版证据、归档和简版 Markdown 导出。首次披露日期归档，同事件增补保留日期，实质进展关联旧事件；已审核条目原子持久化，重启中断任务不发布未审核内容。
- 质量与预算：正文/引文/日期/产品依据校验，独立五维评分和待修正项阻断；5分钟起步、每5分钟检查、18分钟收尾、20分钟硬上限可配置。收尾预留审核时间，失败/超时无未审核发布；操作幂等、版本检查及截止写入保护。研究调用与普通聊天历史、System及角色设置解耦，继续使用既有模型凭据与网络请求底层。
- 兼容性：无旧知识迁移、不导入旧试刊、不自动调度或发送企微消息；Web仅增加受现有管理员/Origin/CSRF保护的研究路由。数据位于 Git 忽略的 `.data/research/`，不受聊天三十天清理影响。部署需构建并重启 Agent/Web，Bridge无需改动；本轮未更新/重启VPS。
- 验证：本机定向与全量回归、真实模型两轮同窗口试跑分别记录于 `dev-history/2026-10-25-industry-research.md`；原始本机审计保留在 Git 忽略的隔离验证目录。早期试跑暴露的审核条件批准与收尾耗尽审核预算已修复，历史结果不作为正式库迁入。

## 2026-10-25 DOCX字体预检与自动PDF转换

- 原因：原检查会把DOCX styles.xml全部字体视为必需，未使用模板样式也会触发Missing source font。用户授权在现有Sync Agent内局部优化，保留真正缺字体时的拦截，不重构或静默替换字体。
- 修改：新增knowledge-sync/docx-fonts.ts，只在DOCX分支使用。收集正文/其他Word部件的样式引用，保留文档默认与默认段落/字符/表格样式，追踪basedOn/link及显式引用闭包；循环安全。排除无引用的样式，不修改XML或字体选择；重复样式、无法解析的引用、无段落默认等情况回退完整样式检查。保留全部活跃声明，不尝试复刻Word逐字符字体槽和覆盖优先级；因此仍可能保守拦截被覆盖或仅供其他字种的声明。
- 范围：正文、页眉页脚、脚注尾注、批注、嵌套文本框的显式字体继续检查，活动编号保守保留完整编号字体集及符号字体；PPTX/XLSX逻辑不变。宏/嵌入/外链/危险字段、ZIP/XML上限、实际字体匹配、私有转换快照、原文件字节保护、PDF渲染/完整覆盖、视觉与文本请求预算及发布校验保持。转换覆盖报告记录排除样式数或保守回退，不删正文、不做字体映射，不新增env/依赖/API。转换缓存版本保持4，已有成功缓存不批量失效。
- 真实文件调查：仅只读核对VPS D81R英文手册的字体/样式和用字统计，黑体确实直接用于173个含文本run、约5388字符，不是单纯闲置模板。VPS Fontconfig请求黑体/宋体均落到DejaVu Sans，Arial/Times New Roman分别落到Liberation Sans/Serif，故不能因这次优化就断言该文件能按原字体转换。此文件仍须补齐实际源字体，或从正确显示的原软件导出并核对PDF；本轮未安装/复制字体、转换生产原件、改写正式知识、调用付费模型或部署VPS。
- 验证：Node22.23.2构建与15项字体/真实转换/XML编码定向全部通过（零跳过）。真实LibreOffice将含未使用缺失字体样式的DOCX转成PDF并进入mock视觉识别，原上传字节不变；同一缺失字体经继承被正文引用后，在渲染和视觉调用前失败。单位用例覆盖默认、继承、linked/字符/条件表格样式、循环、页眉页脚/注释/文本框、备用前缀/实体、编号/符号、引用不明确/重复/无默认回退与危险XML。保留原有ascii/hAnsi/eastAsia显式字体槽范围后，重新构建并对最终工作树串行全量431/431通过（零跳过），git diff --check通过。全量包含原有并行行业研究模块测试；本机mock视觉不等于真实模型或D81R端到端成功。日志.data/debug/docx-font-targeted.log、docx-font-full.log、docx-font-final-full.log。
- 边界：只改转换字体预检和配套测试/文档，保留本轮开始前并行行业研究模块及其他工作树变更，不提交或部署代码。

## 2026-10-25 PDF跨页续表局部修复

- 原因：用户上传的D81R PDF已通过字体与渲染阶段，但第12页Other Attributes末句以“with a”结束，原第13页明确接续“thickness not exceeding 1.5 mm.”。只读核对原PDF、文本及两页渲染确认此处内容没有丢失；原逐页视觉检查在第12页直接因真实页边的未完句报错，尚未结合后一页。用户授权仅局部修复，并明确允许本次在ProductExpertCloud实施与验证，作为当前pi-patrick目录约定的本次例外。
- 修改：仅converter.ts及新增pdf-continuation.ts运行代码。保留普通请求的原提示、单图片载荷及一次超时重试；只有直接PDF的整页区域、全部问题均明确为页尾截断、且存在唯一紧接的整页时，才增加一次双页上下文复核。其他格式、内部切块、末页、混合不可读问题等保持原失败路径，不扩张到通用重试或重构。复核须返回全部问题解决以及目标页结尾/下一页续文原文；目标页文字仍只来自目标图，下一页照常独立检查，续文须在其识别结果中匹配后才登记目标页成功和缓存。
- 保护与兼容：复核失败、无续文证据、独立识别不一致、HTTP/解析/截断/超时/取消和预算不足均停止，不兜底使用此前被拒的结果。复核不额外重试超时，沿用原请求预算、文件截止和并发门；用量继续逐次登记。跨页缓存仅在两页核对后写入，并绑定整个源PDF哈希，避免相同目标页像素借用另一份文档的上下文。普通页旧缓存兼容，CONVERSION_VERSION保持4，不批量使成功转换失效。来源快照、渲染、入库、索引、发布、删除确认及字体预检没有改动；无新依赖/env/接口/系统配置。
- 本机验证：Node22.23.2构建通过；首轮38项跨页/超时/视觉定向全部通过，包含真实PDF worker配合本地mock视觉服务。第一次串行全量453/453通过、零跳过；补充“普通超时后再进入跨页复核”用例并收紧请求循环后，第二次全量454/454通过、零跳过。测试覆盖普通成功与缓存、正常续表、真实截断/混合问题/末页、缺少或虚构续文、后页失败、整体源哈希变化、预算、取消、网络错误、无效/截断响应及复核超时不重试。最终审查又将引用比对收紧为只忽略排版空白，不执行NFKC以免混同上标数字/单位，新增该断言并重新构建，最终39/39项跨页/超时/视觉定向通过、零跳过；此保守收紧后未再重复全量。所有fixture均使用隔离临时目录，不写正式知识；日志.data/debug/pdf-continuation-full.log、pdf-continuation-final-full.log和pdf-continuation-final-targeted.log，git diff --check通过。
- 真实模型验证：用用户PDF原第12、13页制作本地隔离两页样本，现有视觉配置直接转换2次真实请求通过，但本次模型未再触发原误判，因此此结果不单独证明新分支。另回放报告中已发生的首次页尾失败（1次本地回放、非模型请求），随后双页复核和后一页独立识别各执行1次真实模型请求，共2次真实请求成功，覆盖记录包含cross-page continuation verified。两轮实际合计4次模型请求，输入11100、输出2264 tokens；没有把回放计作真实调用。此验证仅限原第12/13页，不代表完整36页或后续入库成功。审计位于Git忽略的.data/debug/pdf-continuation-real*.log、pdf-continuation-replay-real.log及对应隔离目录。
- 部署与范围：保留原有DOCX字体及并行行业研究改动；未提交、推送、部署、重启VPS或发布知识。上线此修复后原失败PDF可直接Re-Sync，不勾Reconvert original以复用已经完成的页缓存；仍会执行剩余页检查和正常入库校验，不保证其他独立问题也自动通过。


### 2026-10-25：行业研究审核超时收尾修正

- 原因：两轮真实检索累计保留4条合格资讯，但第二轮9条候选的整批审核超时导致已做的审核工作无法交付。
- 修改：独立审核员每次提交1–2条判定，后续审核超时/失败保留已完成判定，未完成候选留待下一检查点或最终审核；总任务取消/截止仍拒绝迟到写入。分数、证据、产品依据和待修正项门槛不降低。
- 真实验证：同窗口两轮分别16分50秒和11分11秒，3+1条新增，无重复入库。修正后将9条真实候选与证据隔离回放，53.1秒完成全部审核，8条低于70分、1条有未解决问题，均未新增入库。回放没有重新搜索，不冒充两轮完整重新运行；真实补充/纠错尚未发生，自动化覆盖另记。
- 兼容与交付：仅独立研究模块、测试、规则和文档；保留并行的SYNC/DOCX工作树修改。没有部署、重启VPS或导入验证数据；完整记录见 `dev-history/2026-10-25-industry-research.md`。

- 收尾验证补记：类型检查、构建、19项研究定向与432项全量回归全部通过，零失败/跳过；页面JS语法与git diff --check通过。真实模型结果与本机模拟分开记录，不将隔离证据回放等同于完整重跑。
