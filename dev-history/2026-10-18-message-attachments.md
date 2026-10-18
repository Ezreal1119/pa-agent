# 消息附件与生命周期联动

实现位置 `/Users/patrickxu/ProductExpertCloud`，本轮没有修改 patrick-agent 或实际知识/记忆文件。

- src/agent/message-attachments.ts：消息接受时保存附件 JSONL custom entry；结束时补齐消息 ID；推理阶段追加对应 user 的文件清单。
- src/web/server.ts：验证 attachmentIds、只发附件、SSE message 事件、消息视图附件；独立启动/定时会话清理，已加载过期对象拒绝恢复。
- src/agent/retention.ts：会话过期删除前清理所属文件目录，过程持有与 prompt 共用的锁；失败保留日志，不跟随链接。
- src/agent/runtime.ts / src/file-tools/store.ts：有效会话附件保留、未发送文件不进目录，原有文件存储和解析器继续使用。
- resources/web：待发送 ID 草稿按会话存于当前浏览器；发送成功后在消息下展示，当前会话文件和输出折叠展示。取消待发送不删除原件；手动删除确认说明完整清理范围。

验证：全套 56 项本地测试通过，最终清理锁变动后 17 项相关 Core/Web 文件测试通过。测试显式配置功能开关，避免本机 .env 的 FILE_TOOLS_ENABLED=true 污染原始五工具用例。新增断言使用实际 SDK 生成的请求和 JSONL；模拟主模型，不验证真实模型图像识别质量（此前文件工具迁移已单独验证）。本轮未改解析 worker，不重跑真实视觉接口或 Ubuntu 镜像负载测试。

浏览器采用 4322 隔离服务和一次性测试账号。五个生成夹具 image.png/sample.pdf/sample.docx/sample.xlsx/sample.pptx 一起上传；移除图片、刷新保留其余四个，再补一张图片；发送后五附件出现在对应用户消息下。下一轮只发文字，附件列表为空，刷新后旧绑定仍在。截图 sent.png、模拟请求 payloads.json 及测试数据均在 Git 忽略的 `.data/debug/message-attachment-ui/`。手动删除与过期清理通过自动测试调用真实 HTTP/Retention 接口验证，没有删除用户实际会话。

证据：`.data/debug/attachment-tests.log`（56/56）、`.data/debug/attachment-retention-tests.log`（17/17）、`.data/debug/message-attachment-ui/sent.png`。
