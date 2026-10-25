# UROVO 行业研究与每日情报库

入口：管理员登录后，侧栏 **Industry research**，或访问 `/research`。这是独立研究工作区；不会写聊天记忆，也不读取用户聊天角色。未接入定时执行、WeCom 推送、MCP 写入或自动客户外联。

## 使用

1. 选择截止日期，点击“开始十四天研究”。截止日包含在内：2026-10-24 对应 10-11 至 10-24，时区 Asia/Shanghai。
2. 可关闭页面，后台继续运行。进度显示搜索、网页读取、候选审核及检查点决定；“提前收尾”最多再使用两分钟，并服从总截止时间。
3. 浏览单日、七天或十四天，按主场景和标签筛选。展开日期查看每个场景是未检索、已检索无合格发现，还是已有记录。
4. 详情包含新闻事实、证据、产品资料、竞争信息、销售建议、限制、评分和修订记录。误收可填写原因后归档。
5. 导出 Markdown 仅使用已审核、未归档且未撤回/争议的简版内容。浏览范围按首次披露日期筛选，但显示记录最新版本，截止日之后的补充明确标注。

“首次披露日”不同于事件发生日、转载日和系统抓取日。相同项目实质新进展可新建并关联旧记录；追加来源、设备型号或细节更新原记录，不复制到今日。纠错保留旧版本，已撤回内容不进入默认报告。

## 独立运行与审核

`src/research` 拥有自己的 Agent 会话、工具、存储、服务和 HTTP 路由。普通聊天的运行器、五轮历史、System Prompt、WeCom 角色和三十天会话清理均不参与。

专项 System + `resources/research/SKILL.md` 指导研究方法；`business-context.md` 是业务理解基线；`reviewer.md` 是独立审核标准。可在数据目录的 `research/urovo-business-context.md` 保存管理员修订版；存在时优先使用。每次运行保存完整背景及 SHA-256，运行中不变化。研究员没有改写背景的工具。

正式产品依据只读 `urovo-product-expert`、`memory`、`ums-expert` 根内的 Markdown。搜索仅发送必要公开关键词。引用必须匹配已捕获原文，产品主张必须有内部资料引用；审核员先核对后台从实际正文截取的上下文，必要时补读全文，独立核对业务关系、日期、正文、事实、产品主张及两个版本的一致性。网页里的指令不是授权。

各项0–5分：业务相关30%、商业25%、证据20%、行业重要15%、新增信息10%。默认总分≥70，相关度和证据≥3，所有硬性检查通过且没有待修正项才入库。纠错可低于商业评分门槛，但证据检查不豁免。模型仍可能误判，因此保留可追溯依据及人工归档入口。

检查点独立计算新增贡献：70–84分的新资讯2分，≥85分3分；有实质内容的补充/纠错1分；具体高潜力待核实线索2分（整次任务最多一次）。达到2分且存在下一步方向继续。重复来源、重复提交和润色不计分。没有候选也没有可核实线索时，第一个检查点允许结束。

默认第5、10、15分钟在模型/工具安全边界暂停并审核，第18分钟要求收尾，第20分钟取消剩余调用。审核60秒上限，审核员每完成1到2条即提交独立判定。单次审核超时或后续调用失败时，已完成的有效判定继续执行入库校验，其余候选保持待审核；后续检查点或最终审核可接续处理。整个任务取消或到达总截止时间后拒绝迟到写入，未审核内容不放行。收尾阶段为最终审核预留60秒，剩余时间给研究员提交；不能用生成报告消耗完审核时间。模型请求数还有300次的防失控上限。联网临时错误最多重试两次，404/空壳页面换来源；请求次数统计包含失败重试。后台重新生成导出，不依赖模型最后写出“报告”。

## 数据与恢复

`AGENT_DATA_DIR/research/`（默认 `.data/research/`，保持 Git 忽略）：

- `library/items/<uuid>.json`：稳定条目、版本、引用正文快照及修订历史，是正式库事实来源。
- `library/index.json`：可重建的每日/场景索引，启动时从条目恢复。
- `runs/<uuid>/run.json`：背景快照、配置、覆盖、候选、检查点、计量、停止原因。
- `runs/<uuid>/audit.jsonl`：研究员与审核员的工具/响应审计日志，属于内部数据。
- `runs/<uuid>/evidence/`：本次实际读取的网页及内部资料证据。
- `runtime/`：独立 SDK 的临时目录；正常结束删除，不持久化 API Key。

每次审核逐条原子写入，操作ID防重放、版本号防覆盖；重启将未完成任务标为 interrupted，已入库条目保留，未审核候选不自动发布。再次运行同一日期范围加载既有记录，继续发现与补充。保留历史研究和库数据；不会由聊天会话清理器删除。不要把旧试跑 Markdown 直接复制成正式条目。

## 配置与部署

模型复用 `BASE_URL / MODEL_ID / API_KEY / CONTEXT_WINDOW / MAX_TOKENS`，研究使用 high 推理档，独立审核使用 low 档以控制一分钟审核时限。DeepSeek 直连时复用模型 key，其他模型供应商需配置 `DEEPSEEK_API_KEY`。研究联网能力与聊天页面的工具开关独立。

可选参数均以毫秒计；未设置使用以下默认值：

```dotenv
RESEARCH_INITIAL_MS=300000
RESEARCH_CHECKPOINT_MS=300000
RESEARCH_MAX_MS=1200000
RESEARCH_WRAP_MS=120000
RESEARCH_REVIEW_MS=60000
RESEARCH_THRESHOLD=70
# 权重合计必须为100
RESEARCH_WEIGHTS={"relevance":30,"commercial":25,"evidence":20,"importance":15,"novelty":10}
```

最大时长必须大于初始研究加收尾时间；审核上限不能超过收尾时间。配置在任务开始时固定。参数变化不要求迁移既有条目。

交付代码及 `resources/research`、`resources/web/research.*` 后执行 `npm ci`、`npm run build`，按现有部署方式重启 Web/Agent 服务即可。该功能不需要改动或构建 WeCom Bridge。本次开发不会自动重启 VPS。部署前按既有方式备份 `.data`；研究库属于长期业务数据，也要纳入后续备份。一个数据目录只启动一个 Web 进程；多个副本共享文件目录不属于首版支持范围。

## API 与验证

所有接口沿用管理员 Cookie、Host/Origin 和写操作 CSRF 校验。WeCom/MCP 凭据不能访问。

- `GET/POST /api/research/runs`：运行列表／启动，启动体 `{endDate}`。
- `GET /api/research/runs/:id`，`POST /api/research/runs/:id/stop`。
- `GET /api/research/items?endDate=YYYY-MM-DD&days=1|7|14&scene=...&tag=...`：条目及每天的覆盖。
- `GET /api/research/items/:id`，`POST /api/research/items/:id/archive`（`{reason}`）。
- `GET /api/research/export?endDate=YYYY-MM-DD&days=1|7|14`。

本机：`npm run typecheck`、`npm test`；研究定向测试：`npm run build && node --test tests/research*.test.mjs`。

真实模型：`node scripts/validate-research.mjs --real`。连续研究同一窗口两次，遵循当前时间预算；正式产品库只读，结果放在 `.data/research/validation-<timestamp>/research/`，与正式情报库隔离。该脚本实际消耗模型和搜索额度；只有显式 `--real` 才运行。实际验证结果和剩余限制见对应 dev-history 记录。
