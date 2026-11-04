# 2026-10-08 CKD 简易本地界面

用户习惯原来的字段表单，不熟悉 CLI 的 JSON 输入与多阶段选项，现增加本地界面。

- `npm run ckd:ui` 启动 127.0.0.1:4317；原生 HTML/CSS/JS，无新增依赖。
- 提供 SOP 类型、语言、项目、编号、名称、作者表单；Factory Test 提供有序工序文本框。
- 后续澄清以按钮或允许的文本输入呈现，显示五阶段进度、任务历史、恢复、取消、Excel 下载和逐项评分。
- 新增 Node HTTP 适配层，异步后台任务与页面轮询，关闭页面不影响运行。新增 `create()` 分开持久化与执行，原 start/CLI 行为保持兼容。
- 本机 Host/Origin 限制、固定静态文件、产物真实路径检查和 CSP；README 与设计说明同步更新。
- 保留现有分支工作区改动，patrick-agent 未修改。未接入 Electron，也没有使用旧 Web UI。

验证：`npm run typecheck`、`npm run build`、`npm test`；共 40 项测试，包括 HTTP 表单/回答/重复回答、后台执行/互斥/取消、Excel 下载、跨域及越界文件拒绝。浏览器人工验证表单、Factory Test 实际生成及刷新恢复；API 自动化使用临时 Library，不依赖旧仓库。
