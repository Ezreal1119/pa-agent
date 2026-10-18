# Web 工具调用调试

用户要求逐回答显示工具调用次数，在复制回答旁增加可展开列表。实现范围为 ProductExpertCloud 的本地 Web 测试台。

- `src/web/tool-calls.ts` 按用户轮次重建原始 assistant toolCall 与 toolResult，按 ID 配对；时间取现有运行元数据。历史无元数据时使用 `legacy-round-N`，不修改旧记录。
- `run-metrics.ts` 仅增加逐工具时间字段，快照使用 structuredClone，避免后续对象修改影响历史内存条目。时间与运行轮次在执行期间保存，重启后未结束记录按中断处理。
- `server.ts` 新增会话内工具详情 GET 接口；回答只附带本轮调用计数和引用。事件处理按工具 ID 更新，不再按名称配对。停止后 SDK 最终 assistant 为 error 时也优先保留用户停止状态。
- `resources/web/` 在每条回答下方提供按需列表和原生 details 卡片，参数及返回用 textContent 显示。较长输出在卡片内滚动；手机视图允许换行。
- 本地模拟模型测试 21 项通过；新增工具多步骤、重复名称、执行失败、停止、中断、旧日志、刷新/重启及轮次/会话隔离验证。浏览器模拟环境实测列表折叠、单卡展开、刷新恢复与纯文本输出。无真实模型验证。

原有 .env、Skills、Memory 和源 patrick-agent 未修改。未引入 SQLite、额外结果副本或新的依赖。
