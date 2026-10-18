# 企微联系人独立页面与统计

落盘：/Users/patrickxu/ProductExpertCloud；未修改参考项目、实际.env或VPS。

- 独立 contacts.html / contacts.js，沿用现有登录及CSRF。
- WecomContacts 累计 questions / inputTokens / outputTokens / requests / reportedRequests，按每 session 单调游标去重，保留旧备注和累计值。
- Bridge 带发送者身份，run custom entry 保存 usage 快照；群聊归本轮提问者。历史不回填，缺失 usage 不猜测，数据仅用于调试。
- 回归覆盖群聊归属、工具多请求、缓存/思考口径、并行、停止、重启、重复恢复、删除session、页面/身份权限；原文件E2E仍保留。
- 浏览器用隔离假数据验证入口、独立路由、备注保存、刷新、搜索、完整与缺失提示；截图 .data/debug/wecom/contacts-page.png。测试服务与tab已清理。
- 原先投递恢复测试固定等100ms存在时序问题，改等Bridge idle再重启；未修改生产行为。
- 定向31项通过；完整116项通过（最后SSE响应头顺序调整后复核见core-changelog）。

最终验证：整段恢复按单次事务写入优化后，完整116/116通过，约14.3秒；前端与Bridge语法、diff检查通过。未提交或部署。
