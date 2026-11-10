# 普通 HTTP 问答 API

供自己的脚本/后端通过 curl 或普通 HTTP 客户端调用。复用现有 Product Expert、知识资料、业务记忆、五轮上下文及全局并发队列，不需要 MCP 客户端或网页登录。

## 启用与凭据

在 VPS `/opt/ProductExpertCloud/.env` 配置并重启 `product-expert.service`：

```ini
AGENT_API_ENABLED=true
AGENT_API_KEY=填入独立生成的随机密钥
AGENT_API_WAIT_MS=10000
AGENT_API_TASK_TIMEOUT_MS=900000
AGENT_API_PENDING_LIMIT=12
```

生成方式：`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`。Key至少32个不含空白的可打印ASCII字符；不复用大模型API_KEY、MCP_API_KEY或WECOM_API_TOKEN。默认关闭；关闭返回404，未配置/错误/缺少Key返回401。开关只读env，不受MCP开关控制。

每个请求使用 `Authorization: Bearer <AGENT_API_KEY>`。公网沿用 `WEB_PUBLIC_URL` 和现有HTTPS反代；本机可用 `http://127.0.0.1:4321`。Key只放请求头，不放URL，不传给网页前端；Cookie、CSRF Token、Session ID不能替代API Key。该Key仅授权本API的提问、查结果和取消，不开放管理员接口。

当前是单接入方Key模式：持有同一个Key的程序属于同一个调用身份，可以访问同一API命名空间中的会话/任务。更换Key并重启会立即拒绝旧Key，已保存的任务和会话由新Key继续访问。不同客户/租户的独立授权不在本版范围内。

## 提交问题

```bash
# 在调用机器安全设置环境变量；不要把真实Key提交到Git。
export AGENT_API_BASE=https://urovo-agent.patrick-shenzhen.cn
export AGENT_API_KEY='你的应用调用Key'

curl -sS "$AGENT_API_BASE/api/v1/ask" \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"question":"DT66有没有实体数字键盘？"}'
```

严格只接受：

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| question | 是 | 非空文本，最多12000字符，保留原始文本 |
| conversation_id | 否 | 上次本API返回的会话UUID；省略则新开对话 |
| request_id | 否 | 调用方生成的UUID；同一次请求的网络重试复用它 |

不传文件、角色、工具参数、任意路径或浏览器/企微Session ID。JSON必须是UTF-8对象，请求体最多64KiB，不支持URL查询参数。

默认最多等10秒。已结束返回HTTP 200；仍排队/运行返回HTTP 202，例如：

```json
{
  "task_id": "服务器返回的任务UUID",
  "conversation_id": "服务器返回的会话UUID",
  "status": "running",
  "answer": null,
  "poll_after_ms": 2000
}
```

实际还包含model、created_at、finished_at、elapsed_ms、tool_calls和usage。快速回答或最终查询结果中，answer为答案字符串。`usage`统计当前任务全部工具循环中的实际模型用量；`coverage`表示用量回传是否完整，不估算缺失Token。

## 查结果、追问与取消

```bash
export TASK_ID='本API返回的task_id'

curl -sS "$AGENT_API_BASE/api/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $AGENT_API_KEY"

# 取消不需要JSON body。
curl -sS -X POST "$AGENT_API_BASE/api/v1/tasks/$TASK_ID/cancel" \
  -H "Authorization: Bearer $AGENT_API_KEY"
```

GET查询始终按任务存在性返回HTTP 200/404，未完成时answer=null；至少等待poll_after_ms再轮询。不要重复提交问题来轮询。取消是协作式的，返回cancellation_requested；继续查结果直到终态。

追问时，POST ask并加入上一轮的conversation_id；同一会话已有未完成任务时返回409。新话题省略conversation_id。API会话UUID与网页、企微及MCP的句柄互不通用。

状态为queued/running/completed/failed/cancelled/interrupted。HTTP 200只表示成功取得任务状态，调用方仍须检查status；失败任务会带error。HTTP断开不取消已接收任务，可用相同request_id重试取回原task_id。服务重启会恢复已有结果、将真正未完成的任务标记为中断，不自动重放计费请求。

## 去重、排队与保留

- 相同request_id、相同问题及兼容会话参数复用已有任务；换了问题/指定了不同会话却复用同一request_id返回409。此去重在任务保留期内跨重启有效，过期/删除后不保证。
- 去重也保留第一次失败/取消结果。如果要明确再执行一次，使用新的request_id。
- API与Web、企微、MCP共享默认4个运行、8个等待名额，文件重任务仍串行。API另有限制：最多12个未完成任务，最多保留5000个任务。不会另起无限执行池。
- 自身待处理队列或共享执行队列已满时返回429、Retry-After；共享队列拒绝有时已经生成失败task_id，返回error_code=capacity_exceeded。这种任务未调用模型。
- 默认15分钟任务期限含排队；取消/轮询不增加模型请求。任务与答案保存于 `.data/http-api/`，保留30天；与原Session一样，闲置会话30天失效。管理员删除该会话时同时清理API句柄和答案。
- HTTP API任务统计与MCP任务统计分开，原MCP开关/统计不变。

## 错误状态

400：参数/JSON错误或本不接受body的操作收到body；401：Key无效；403：Host/Origin被拒绝；404：关闭/句柄不存在或过期；405：方法不支持；409：同会话冲突或request_id冲突；413：请求过大；415：非JSON提交；429：容量已满；500：内部错误。

本API没有后台管理、文件上传或共享记忆写入能力。它保留既有只读产品检索和联网/资料库工具设置，API Key不进入提示词、对话历史或公开响应。
