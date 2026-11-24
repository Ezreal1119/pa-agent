# 按需记忆召回

在 Web **Agent settings → Memory recall** 里切换后点击 **Save and apply**。默认关闭，主 Agent 会直接读到两份记忆全文。打开后，Web、企微、HTTP API 和 MCP 的主 Agent 可主动调用 `recall_memory`。设置保存后从下一次请求生效，重启后继续使用保存的选择。保存时如有会话正在处理请求，先等该请求完成。

`MEMORY_RECALL_ENABLED` 为 Web 未保存此项时的初始值，也可供直接调用 Agent Runtime 的使用方配置。

Supervisor 根据当前问题和对话决定什么时候召回，并补充型号、版本、功能等线索。每次召回最多发一次模型请求，用独立 Prompt 判断相关性和适用范围。后端验证结果格式、来源 ID 和原文引用。结果附带日期、适用条件和相关性说明。无命中和执行失败会分别报告。产品 Skill 及普通知识检索仍可用。

`MEMORY_RECALL_INPUT_MODE=full` 是默认模式。筛选模型收到 `MEMORY.md` 和 `MEMORY_EXTRA.md` 的全部条目正文及必要的来源信息。每条记忆在 JSON 中保留独立的来源、ID、类别、更新时间和正文字段。全文与固定提示放在当前查询之前，以便模型服务复用输入前缀。可用 `prompt_cache_hit_tokens` 或供应商提供的等效用量字段确认命中。设为 `candidates` 可改为本地先选最多 16 个片段再筛选。

Supervisor 可以直接使用召回摘录。若需核对完整条件，可用 `memory` 的 `get` 操作，传入 `id` 和 `source`（`main` 或 `extra`），直接读取本轮快照中对应条目的全文。这一步无需再请求筛选模型。下一轮读取更新后的快照。历史工具详情保留召回和条目原文，后续模型上下文用提醒替代它们。

Supervisor 默认把同一道题里的型号、版本和疑点合在一次召回里。首次执行失败或超时，且缺失的证据会影响答案时，可以用原条件重试一次。正常查完后，有可能改变答案的新线索时可以补查。同一轮内，查询、背景和标识相同的请求复用已有命中或无命中结果，共用一次模型用量。下一轮重新查找。

`memory` 也处理用户明确授权的额外记忆修改。编辑和删除前须在本轮召回准确的额外记忆条目，写入检查 Revision。MCP 只开放 `get`。管理员编辑和 Memory Injection 沿用现有入口。

ONES 与 Memory 复用任务调度及用量账本。默认 Memory 并发 2，等待上限 8，每次调用总时间 180 秒，每个用户问题至多 3 次召回。程序化测试可通过 `memoryRecall` 覆盖队列设置和输入模式。普通问答用量包含 Memory，`memoryTasks` 和 `agentUsage.memory` 单独显示召回任务。HTTP API 和 MCP 对应字段为 `memory_tasks` 和 `agent_usage.memory`。账本来源为 `memory-recall`。

本地验证使用隔离的模拟模型和 MCP 服务。

```sh
npm run build
node --test tests/memory-recall.test.mjs tests/ones-agent.test.mjs tests/ones-integration.test.mjs
```

对比全文与候选时，两组使用同一批脱敏查询、同一模型和同一份记忆快照。记录是否找到适用原文、是否遗漏或误用证据，以及缓存命中、耗时与成本。只测筛选环节时，给两组传入相同的查询和背景，固定 Supervisor 对查询的影响。
