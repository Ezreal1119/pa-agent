# ONES 专业 Agent

ONES 专业 Agent 使用现有 Pi core 和模型连接，在同一个应用进程内运行。主 Agent 通过 `ask_ones_agent` 委派查询，ONES 自行执行查询并返回证据、限制和需要澄清的问题，主 Agent 统一回答。

## 启用与配置

更新依赖时运行 `npm ci`，构建后再按现有部署流程更新服务。本次实现不自动部署、设置真实凭据或重启服务。

在部署环境填写：

```dotenv
ONES_MCP_URL=https://ones.urovo.com:8881/mcp
ONES_MCP_TOKEN=<你的 ONES 手工 MCP Token>
```

重启服务以加载连接配置。在侧栏打开 **Sub-Agents**，启用 **ONES Agent**。默认关闭，开关设置会保留到下次重启。旧的 `ONES_AGENT_ENABLED` 环境变量可以移除。开关保存后对后续 Web、企微、HTTP API 和 MCP 问答生效。如果当前有问答运行，等待完成后再切换。页面可展开查看 Supervisor 委派工具、ONES Prompt 和工具允许列表。

应用固定发送 `X-ONES-MCP-Token`。当前 ONES 服务实测该请求头可用；相同 Token 使用 `Authorization: Bearer` 曾返回 invalid_token。凭据仅由后端连接层使用，不加入模型 Prompt、配置 JSON、URL、普通日志或错误响应。没有配置凭据时不能启用。仅允许 HTTPS；本地回归夹具允许 localhost HTTP。拒绝跳转，避免凭据跟随重定向。

配置分为：

- `resources/agents/ones/system.md`：职责、业务术语、查询规则、来源要求和最终提交方式。用户“发布记录”“工单”等用语不直接等同于某个 ONES 类型；应查询后确认。
- `resources/agents/ones/config.json`：工具允许列表、任务预算、并发和上下文策略。所有字段通过统一配置校验，修改后重启生效。
- 环境变量：MCP 地址和凭据。模型连接及推理级别复用主 Agent。

JSON 默认值：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `tools` | 首轮验证的 39 个查询工具 | 配置允许列表与实际发现列表取交集；未发现的工具不会注册 |
| `timeoutMs` | 180000 | 从接受委派开始计时，包含排队、等待整理、连接和模型/工具运行 |
| `maxModelRequests` | 24 | 每个子任务最多模型请求数，不自动重跑整个任务 |
| `maxToolCalls` | 48 | 每个子任务最多 MCP 工具调用数 |
| `maxDelegations` | 3 | 每个主问题最多委派次数 |
| `maxContextChars` | 32000 | 模型填写的委派参数 JSON 长度上限；不含后端附加的问题原文 |
| `maxResultBytes` | 1048576 | MCP 单次网络响应和工具结果上限，超限要求缩小范围/分页 |
| `concurrency` | 2 | 所有 ONES 任务共用的独立运行名额 |
| `queueLimit` | 8 | 全局和每个子会话的有界等待队列 |
| `compaction.enabled` | true | 本版持久上下文要求开启压缩 |
| `compaction.triggerTokens` | 384000 | 独立于主会话 CHAT_COMPACTION 配置 |
| `compaction.keepRecentRounds` | 5 | 保留最近五次完整委派及工具调用/返回 |

触发阈值必须小于 `CONTEXT_WINDOW - MAX_TOKENS - 16384`。启用前将 `CONTEXT_WINDOW` 设置为模型真实容量，或调低 ONES 阈值；不得为了通过校验虚报容量。主 Agent 压缩开关不影响 ONES 子会话的压缩。

工具配置只能从已审核的只读工具集合中选择；修改 JSON 不能开放写工具。新增工具需先检查语义并修改后端允许集合。实际能力仍取决于 ONES 的 Token scope、账号权限和团队能力。第一版不开放写操作、shell、任意本地文件读取或主 Agent 的工具。

## 上下文与返回结果

`ask_ones_agent` 要求主模型填写 `task`、`background`、`confirmedFacts`、`corrections`、`constraints`、`unresolvedQuestions`。无相关内容时可使用空字符串/数组。主模型在现有推理内选择必要背景，不额外发起一次整理模型请求；当前用户问题原文、时间和会话关联由后端附加，模型不能覆盖身份或指定其他子会话。

超长输入返回明确错误，不静默截断用户纠正。不要复制整段聊天历史、主系统提示、全部产品记忆或凭据。附件不会自动进入 ONES Agent；必要事实可由主 Agent 读取后作为相关背景传递。

ONES Agent 通过内部 `finish_ones_task` 提交 `status`、`answer`、`sources`、`unknowns`、`questions`，成功提交后停止。来源 ID/URL 必须出现在本次查询结果中，历史来源需要重新查询验证。状态包含 completed、partial、needs_clarification、failed；后端还可返回 cancelled 或 interrupted。结果带 taskId、耗时、工具次数和实际 usage。

主 Agent 接收任务结果，不接收全部原始工具输出；原始查询过程保存在独立 Pi JSONL。主 Agent 遇到澄清请求应向用户询问，遇到权限限制应明确说明“当前账号可见范围内未查到/没有权限”，不能推断系统中不存在记录。所有外部记录、评论、Wiki 和附件内容均作为数据，不授予额外权限。

## 生命周期、访问与统计

- Web、企微、HTTP API、MCP 沿用现有入口授权。所有用户通过同一 Token 使用该 ONES 账号的数据可见范围；会话隔离不等于每用户独立 ONES 权限。
- `.data/agents/ones/parents/<主会话 ID>/sessions/` 保存独立 Pi JSONL；`tasks/` 保存委派输入和任务结果。文件不由普通会话列表/端点枚举，也不在原生 read 工具的允许根目录内。仍使用单服务进程管理同一数据目录。
- 每个主会话一个子会话，同一子会话串行，不同子会话可并行；群聊沿用现有整群共享边界。ONES 不再申请普通问答 RunGate 名额，主 Gate 为 1 时也可完成委派。
- 结果持久化并返回后安排后台压缩；下一次访问同一子会话等待压缩，其他会话继续运行。摘要合并旧摘要，保留查询条件、型号版本、记录 ID、用户纠正、权限限制和未完成事项。原始日志不删除；压缩失败保留有效上下文和已完成结果，后续按原有冷却规则重试。
- 用户取消向子模型和 MCP 传播。删除主会话协调取消、等待收尾后清理子会话，保留进程内删除标记防止旧闭包重建目录。新建主会话不复用旧子会话。
- 重启恢复会话、摘要和有效上下文；未完成任务标为 interrupted，不自动重新执行。模型 usage 快照保存到子 JSONL；主会话的委派收据补齐取消/中断时可能没有发出工具完成事件的用量。
- 无活动 30 天、主会话不存在的子数据会清理；设置切换和服务关闭协调取消、关闭 MCP 连接及压缩任务。
- Web/企微显示查询及整理状态。普通工具详情保存委派参数、结果和 taskId；`/patrick_detail` 显示主回答及 ONES 子任务耗时、状态、查询次数和 token 摘要，不暴露内部思考。
- 主问答指标的 usage 包含子任务，并增加 onesTasks；Web 返回 agentUsage，HTTP API/MCP 任务返回 agent_usage 和 ones_tasks，分别列出主模型及 ONES 用量。重复收据不会重复累计。真实请求账本来源为 ones-agent，整理来源为 ones-compaction；整理费用不算进已完成问答用量。

## 本地验证

```sh
npm run test:ones
```

测试使用本机模型和 MCP 夹具，覆盖独立 Prompt/工具、问题原文和纠正传递、认证失败、取消与超时、并发隔离、重启恢复、五轮压缩及 Web/企微/HTTP API/MCP 生命周期；不连接真实 ONES、不调用真实模型。启用后的真实模型查询质量和企业内网络访问由部署后的实际使用验证。
