# Text-only Product Expert MCP

MCP 使用现有 `product-expert.service`，入口为 `/mcp`，采用官方 SDK 的 Streamable HTTP 传输。无需管理员登录、Bearer Token 或 WeCom 凭据。`MCP_ENABLED` 默认关闭，启用后即可匿名调用；管理页面和原 Web/WeCom API 的认证规则保持不变。

## 启用与连接

本轮新增 npm 依赖，VPS 更新代码后需要 `npm ci`：

```sh
cd /opt/ProductExpertCloud
git pull --ff-only
npm ci
npm run test:mcp
```

在 VPS `.env` 中增加：

```ini
MCP_ENABLED=true
# 已有 HTTPS 域名配置保留；不填 /login 或 /mcp
WEB_PUBLIC_URL=https://urovo-agent.patrick-shenzhen.cn
```

然后执行 `systemctl restart product-expert.service`。不需要增加 systemd unit，也不需要重启独立 WeCom Bridge。现有反代若已将 `/` 转发到4321端口，无需单独开放4321公网端口。

在支持远程 Streamable HTTP 的 MCP 客户端中填写 URL：`https://urovo-agent.patrick-shenzhen.cn/mcp`，认证选择 None。具体客户端配置字段以该客户端为准；这里不提供只适用于某一客户端的通用 JSON。Host/Origin 仍检查现有本机地址或 `WEB_PUBLIC_URL`，不接受任意浏览器跨站来源。

## 三个工具

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `ask_product_expert` | 必填 `question`；可选 `conversation_id`、`request_id` | 新问题省略 conversation_id；追问复用返回值。快请求直接给最终文字，慢请求给 task_id。 |
| `get_task_result` | `task_id` | 获取状态、最终文字、耗时、工具次数、Token。待完成时按 poll_after_ms 等待再查询。 |
| `cancel_task` | `task_id` | 请求停止排队/运行任务；再查询确认最终状态与已记录用量。 |

只接受非空文本（最多12000字符），拒绝附件参数；没有文件上传/下载、Excel 写入或 memory 写入能力。四个只读检索工具保留，资料库链接和联网工具沿用管理员的独立开关。MCP 内部 session 不会因为 Web 文件工具开启而获得文件写入权限；读取范围收窄至技能/知识库，配置和其他会话不可由原生读取工具访问。

任务响应同时包含标准 `content` 文本和 `structuredContent`：

```json
{
  "task_id": "<opaque UUID>",
  "conversation_id": "<opaque UUID>",
  "status": "completed",
  "answer": "The final answer",
  "elapsed_ms": 1500,
  "tool_calls": 2,
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 150,
    "total_tokens": 1350,
    "model_requests": 3,
    "reported_requests": 3,
    "missing_requests": 0,
    "coverage": "complete"
  }
}
```

完整状态为 queued/running/completed/failed/cancelled/interrupted，pending 返回 `answer:null` 和 `poll_after_ms:2000`。首次最多等待10秒后返回任务句柄；后台执行与 HTTP 连接分离，断开连接不自动取消。不要重复 ask 作为轮询。可选 `request_id` 是调用方生成的随机 UUID，相同问题/会话重试复用已有任务，冲突请求拒绝；过期/删除后不再保证此去重。

这是三个普通 MCP 工具实现的异步任务流程，**不是标准 MCP Tasks 扩展**。兼容不支持 Tasks 扩展的客户端；已用官方 SDK 客户端和2025协议请求做本机验证。同一 conversation 同时只接受一个待完成任务，不同 conversation 与 Web/WeCom 共用 `AGENT_MAX_CONCURRENT_RUNS` / `AGENT_RUN_QUEUE_LIMIT`；不另开无限执行池。

## Token 口径与管理页面

登录 Web 后，左侧 **MCP usage** 打开独立 `/mcp-usage` 页面，可查看累计提交数、输入/输出/总 Token、模型请求数、usage 覆盖及最近50个任务。受管理员认证的 `GET /api/mcp/usage` 还包含按 conversation 的累计用量；MCP 工具不开放其他调用者的任务列表。匿名调用无法归属到经验证的真实个人。

- 累计本次 Agent 工具循环中所有 SDK 模型请求，不只统计最终一条回答；输入含 cacheRead/cacheWrite，输出已有的 reasoning 不再重复相加。
- 查询任务和取消操作不执行模型；幂等重试不启动新任务。第三方 search/fetch 按次费用、资料库上游内部成本、调用方自身大模型用量不计入本服务模型 Token。
- 只统计实际收到的 usage，不估算字符数。coverage 为 not_started/unavailable/partial/complete，明确区分未启动和未返回用量。中断、超时或供应商未回传时可能缺失，这些记录不是供应商账单。
- 元数据 `.data/mcp/state.json` 原子串行写入；逐run usage 同时保存在原 session JSONL 中，重启补齐增量并去重。已结束回答单独保存在 `.data/mcp/answers/`；未完成任务重启标为中断，不自动重放计费请求。
- 任务/回答保留30天，conversation 最后活动30天失效，SDK会话沿用原30天保留策略。手动删除会话同步删除句柄和回答；累计 Token 和任务计数保留。进程中断导致的孤立回答文件在启动/定时清理时删除。
- 与原 session 目录一样，MCP目录只能由同一个 Web服务进程写入，不支持多实例共享目录。

可选配置（修改后重启）：

```ini
MCP_WAIT_MS=10000
MCP_TASK_TIMEOUT_MS=900000
MCP_PENDING_LIMIT=10
```

等待窗口0～25000毫秒；任务期限包含排队时间，默认15分钟；MCP待处理数默认10，另外受共享Agent队列约束。默认最多保留5000个任务，达到容量明确拒绝新任务，防止持续堆积。

## 验证范围

`npm run test:mcp` 构建并运行隔离 MCP 回归；`npm test` 包含该组。本机测试使用官方 MCP 客户端、真实 Core SDK 和模拟模型，覆盖工具循环 usage、异步结果、重启、取消、幂等、权限、队列和清理。没有自动连接生产域名或真实模型，VPS升级后仍需用实际 MCP 客户端问答验收。
