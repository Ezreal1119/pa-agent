# 2026-10-17 思考强度与 Web 逐轮计时

实施范围：ProductExpertCloud。原 patrick-agent 与 VPS 只保留原状；没有读取或输出模型密钥，没有改写用户 `.env`。

- 依据 DeepSeek 当前 Chat Completions 参数，实现 off→thinking.disabled/effort.none，以及 low/high/max→thinking.enabled/对应 effort。默认 low，不使用会映射到 high 的 medium 作为日常 Web 默认。
- Core provider 为识别的 DeepSeek 模型注册 thinkingFormat、强度映射、max_tokens 和助手消息 reasoning_content 回传；Web 在最终 payload 上应用本轮值，并从同一 payload 提取检查元数据。
- 新增 `src/agent/reasoning.ts`、`src/web/run-metrics.ts`，更新 server、页面及测试。每轮耗时以 backend performance.now 计算，用户可看到进行中秒表、完成后的消息徽标、首段文字等待和最近五次记录。原 JSONL 的 custom entry 保存数据，不将耗时或其他 UI 元数据送入模型。
- 失败和手动停止也记录耗时；刷新、重启恢复记录。既有无计时轮次不回填，有开始无结束则呈现中断与未知耗时。沿用会话清理，无单独永久 sidecar 文件。

本机验证：全部 17 项测试通过，覆盖参数、兼容工具循环、强度切换、每轮快照、五轮上下文、计时、持久化与失败/停止。浏览器使用 4322 上的隔离模拟模型，响应明确标记为模拟，不使用真实业务知识或 API Key。验证思考选择与锁定、实时计时、完成后保存/刷新恢复。

限制：低强度不是时间硬上限；工具检索仍可能耗时。未做真实 DeepSeek 请求和效果比较，未新增工具总次数或任务总时长预算。其他提供方的参数适配保持原行为。
