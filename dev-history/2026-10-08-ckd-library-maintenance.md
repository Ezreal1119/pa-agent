# CKD 翻译与摘要维护 API

## 变化

在 `pi-patrick/create-ckd-sop` 增加两个独立后台任务入口：POST `/api/library/translate` 和 `/api/library/summaries`。共用持久化查询、恢复、取消接口；不增加 UI、Electron 或留白检测，不由 SOP 生成自动触发。通用 `src/agent` Core 未修改，没有新增 npm 依赖。

来源解析取自旧项目 `library/ckd-library-v2/summary-sync-core.mjs`，将 ESM 接口改为 CommonJS 后放入本项目 resources；来源 Hash 和转换说明见 `resources/ckd-maintenance/source.json`。旧项目的配置服务、数据库、SDK runtime、扫描 workspaces 和引导子进程未迁入，也未运行旧脚本。

翻译按文件记录源和目标 Hash，接管可验证的历史翻译，更新未人工编辑的自动译文，保护独立内容和空值覆盖。数字、行数、软件文件名、技术标识、明确引用的 UI 文本/路径/命令校验失败时不写入。JSONL 保留行和字段，图片原字节复制；原文删除仅报告。翻译和摘要两个接口分开调用。

摘要维护包含五种类型及 Assembly 字段、英文项目独占及中文公共回退、中英文隔离、多图与前站图片、旧 Hash/摘要格式兼容。图片 SHA-256 缓存跨语言/任务复用；图片描述需要语言转换时调用文字翻译而非重复识别。不同历史描述保留本地原描述并报告。完整逐文件翻译来源可证明等价时复用并翻译概述，否则分别概述。旧目录不自动删除。

新增视觉环境变量 `VISION_BASE_URL / VISION_API_KEY / VISION_MODEL_ID`，缺失时新图片识别明确失败，历史描述仍可复用。文字模型继续使用现有配置；维护请求使用独立无工具 Chat Completions 适配器，不开放工具。DeepSeek 的维护请求关闭 thinking，不影响 Core。

Library 在 SOP 执行与维护之间通过跨进程锁互斥，等待用户回答时释放。维护文件提交先备份、暂存、验证来源与目标，再逐文件原子替换；永久事务清单保存来源、修改前后 Hash 与备份映射。中断事务通过 pending 标记阻止 SOP 读取半提交的摘要，恢复后补齐或回滚。翻译注册记录随文件恢复，避免回滚后错误接管。任务重启后显式 resume，不会自动发起付费模型请求。

## 文档

更新 README 的两个接口 curl 示例、筛选参数、任务状态、恢复、缓存、锁和视觉配置说明；更新 `.env.example`、CKD 设计及 `docs/core-changelog.md` 当前架构与累积记录。没有修改 patrick-agent 文档或调用其生成器。

## 验证

- `npm run typecheck`
- `npm run build`
- `npm test`：68 项通过，其中新增 23 项维护测试。
- `git diff --check`

新增测试覆盖双向翻译、自动跟随更新/人工保护、已有空值和独立照片目录、JSONL 错误及 UTF-8、模型输出校验、历史翻译接管、语言隔离与双向概述来源证明、项目继承、Assembly BOM/前站检查、多图排序、Hash 缓存和新增图片、旧摘要复用、保留失效目录、无视觉配置、超时/取消、外部修改、互斥、重启恢复、文件提交恢复/回滚以及 curl/HTTP 安全边界。

真实文字模型联调：使用现有文字模型配置，通过实际 HTTP 接口在独立临时 Library 中依次运行 translate 和 summaries，两任务均 completed，各更新两项；生成中英文摘要和概述，数字 1、USB-A 和 CameraApp.exe 保留。记录位于 `.data/ckd/maintenance-smoke/2026-10-08T10-30-09-614Z/report.json`。正式 Library 未执行全量翻译或摘要更新。

真实视觉模型未验证：当前 `.env` 没有独立视觉配置；图像消息结构、成功/失败缓存、历史描述、跨语言复用、超时和错误路径使用模拟模型验证。需要配置支持 image_url 的真实模型后再做小范围联调。Windows 实机验证仍留待桌面打包阶段。

旧项目只读核对：实施前后 4,053 个文件 Hash 一致，文件集合和 Git 状态一致；记录在 `.data/ckd/maintenance-old-repo-verification.json`。

## 后续：真实视觉模型联调与字面量保护修复

用户补齐独立视觉配置后，使用 `qwen3.8-flash`，通过真实 HTTP summaries 接口识别一张现有 ANT Config 软件界面截图。测试在独立临时 Library 中进行，只复制原图；正式原图 Hash 未变。

首次视觉请求成功，识别出 ANT Config、LTE/WIFI 分组、ReadBarcode、测试参数及 Save 等可见控件。中文图片描述翻译被原来的严格字面量校验拦截，维护任务正确保存英文结果并报告中文项失败，没有写入无效中文产物。

修复：翻译前将引用的 UI 标签、命令、路径及单位替换为逐项占位符，模型返回后检查占位符数量、还原原文，再执行原有数字/技术标识/行数/字面量校验。路径识别增加词边界，避免将 Field/dropdown 这样的普通短语当作绝对路径。未放宽原有技术字段校验，通用 Core 未修改。

复测使用首次识别产生的缓存，未重复调用视觉模型。中文图片描述和概述成功生成；随后普通维护两个工序均 reused，未新增任何模型请求；force 仅重建两份概述，仍没有新增视觉请求。整个联调同一图片只调用视觉模型一次。

原始失败报告和成功复测报告分别在 `.data/ckd/vision-smoke/2026-10-08T10-55-23-964Z/report.json` 与 `retest-report.json`，均为本机忽略数据，不包含 API 密钥。

补充回归覆盖保护占位符完整性、UI 标签/单位/命令保留和普通斜杠短语。`typecheck`、`build` 和全部 69 项测试通过。Windows 实机验证仍未开展。
