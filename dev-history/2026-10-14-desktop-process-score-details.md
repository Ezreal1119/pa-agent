# 2026-10-14：桌面工序资料评分展开

用户反馈完成页的“工序资料评分”只显示工序和分数，无法查看原有扣分说明。本次在桌面端将每条工序改为可点击展开的行；展开区直接读取任务结果中已有的 `processReviews`，展示评分原因、概述、Operation/完整度/跨层缺口/语义匹配四项的扣分与说明、总扣分、资料来源及警告。没有更详细记录的旧任务显示明确提示。动态文字只通过 DOM `textContent` 插入。渲染时保留当前已展开的工序。

仅修改 `desktop/ui/app.js`、`desktop/ui/style.css` 和桌面版本/发布材料；未修改后端 API、评分规则、模型、工作流、Library、任务数据或产物。客户端版本从 0.1.3 升为 0.1.4，云端地址仍为 `http://8.133.254.83`，服务器无需重新部署。Windows 需在 Windows x64 上用 0.1.4 独立源码包构建安装包。

验证：`npm --prefix desktop test` 13 项通过；`node --check desktop/ui/app.js` 与 `git diff --check` 通过；`npm --prefix desktop run pack:mac:cloud` 成功；检查 Mac 包内版本、云端地址及展开视图代码；Mac ZIP 和 Windows 源码 ZIP 的 `unzip -t` 均通过。当前 Mac 桌面在原生界面验证期间被系统锁定，未完成展开点击的人工验收；Windows 安装包及实机操作也未在本机验证。未调用模型或改动正式数据。

产物：`desktop/release/cloud/CKD-SOP-Cloud-0.1.4-mac-arm64.zip`（SHA-256 `3dd79f224bf417e91d73277fc374e52200dabb2a6ab9b9fd5dd4adb904371a25`）；`desktop/release/cloud/CKD-SOP-Cloud-Windows-Source-0.1.4.zip`（SHA-256 `ac19902fd039cf5ff41a3a4925fdf712e6d8e8b057274cf8c12dcccdda13dd9a`）。
