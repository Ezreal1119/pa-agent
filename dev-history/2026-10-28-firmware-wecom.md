# 2026-10-28 · OS 固件企微接入

## 行为

- `/firmware` 为隐藏命令，不出现在欢迎消息或快捷菜单中；仅显式输入进入，支持命令后输入或命令同行文件名。
- 全局一个固件流程，覆盖输入、FTP/AI 匹配、选择、带本次确认码的用户确认、下载和 R2 上传。普通聊天保持原有并发。
- `firmware` 独立工具开关在 Agent Settings Tools List 中管理。旧设置默认关闭；关闭后入口维护提示，已接受的任务继续跟踪。
- 本机或隧道离线、FTP/磁盘/上传配置检查失败时，新入口维护提示；已接受任务保留身份与占用，恢复后继续查询。
- 在确认后第 1/2/3/5/7/10/15/20/30 分钟主动报当前阶段，30 分钟后每 10 分钟；成功、失败或确认取消后通知并释放占用。
- 云端持久状态、幂等提交恢复和通知 outbox；Bridge 持久投递片段检查点；不依赖 AI 长请求或原企微回调窗口。

## 代码和配置

- 云端实现：`src/firmware/`、`src/tools/firmware.ts`、Web 机器 API、设置存储/Tools UI、提示词工厂。
- 企微实现：命令控制路径、独立固件通知器、输入模式归属及退出、既有 Bridge Store 检查点。
- 本机代码仍在被 Git/Docker 忽略的 `local-download-service/`；新增受限 `/firmware-api/`、真实健康检查及按请求键查询。无 PRO/RD 或海外 SFTP 支持。
- 本机 `~/.cloudflared/config.yml` 新增固件专用 ingress，转发到 `127.0.0.1:8765`，覆盖 Host 并关闭分块传输。旧 APP 4824 与 Agent 4958 规则保留。
- 观察到 QUIC 空闲连接频繁超时重连，改为 HTTP/2 后注册四条连接并完成公网验证。旧配置备份保存在本机服务的忽略目录。
- 本机 `.env` 配置了 `FIRMWARE_SERVICE_URL/TOKEN/PUBLIC_URL_BASE`。Token 未输出到文档或加入 Git。本机没有现成的 Agent 设置文件，因此未生成或覆盖其他工具偏好；启动 Web 后可以通过 Tools UI 开启。
- 管理员上线步骤：[docs/firmware.md](../docs/firmware.md)。不需要新 npm 依赖、systemd timer 或原服务 unit 调整。

## 验证

- `npm run typecheck`、构建、相关 JS 语法检查和 `git diff --check` 通过。
- 最终全量 `npm test`：**571/571**，零跳过，约 69.94 秒。日志 `.data/firmware-full-tests-final.log`。
- 最终固件与 Bridge 定向：**45/45**。日志 `.data/firmware-final-targeted.log`。
- 本机服务测试：**31/31**，约 45.61 秒。日志 `local-download-service/data/test-robot-integration.log`。
- 覆盖真实 Web + Bridge API、真实 SDK 对约束工具的调用、强制命令入口、关闭/离线维护、跨用户/机器人归属、确认码、全局占用、按时点通知与去重、丢失提交响应恢复、重启、通知租约及 ACK 丢失、超时退出普通聊天、URL 编码和错误结果不泄露链接。
- 通过真实公网隧道访问本机 readiness；FTP、磁盘、worker、rclone 配置均通过。
- 真实模型测试：将 `VendorEN` 写成 `VendroEN`，从 12 个真实 FTP 候选中选中 `SQ27M_EN_XX_WE__DS_FI_S02_U_251205_02_rel_uFWsign_VendorEN.zip`。证据 `.data/firmware-live-match.json`。停在匹配阶段，未启动正式包传输。
- 原有 APP/Agent 路由通过 `cloudflared tunnel ingress rule` 验证未改变。扫描改动与未忽略新文件，未发现本机固件 token。

## 边界

未提交、推送、上传或部署代码，未连接/改动 VPS，没有启动第二条真实企微机器人连接或发送真实企微测试消息。VPS `.env`、构建、两项服务重启及工具开关由管理员按文档完成后，才代表真实机器人上线。首次实际包传输仍需要该用户在企微明确确认，模拟测试和真实匹配不替代正式包长时传输验收。
