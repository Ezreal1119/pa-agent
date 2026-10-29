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


## 强制代理补充 · 2026-10-28

核对 ~/.zshrc 后确认旧项目 start 由 proxychains4 包裹，读取 /opt/homebrew/etc/proxychains.conf 的 strict_chain 与 socks5 127.0.0.1:7897。新本机服务的 R2 上传及对象校验现已使用该配置，并显式设置 rclone --http-proxy、覆盖代理变量和清空 NO_PROXY；代理异常禁止直连。FTP 在未包裹的主进程中保持直连。未修改原 Proxychains 文件，派生配置只豁免连接代理自身的回环地址，避免双重代理。

本机完整测试 38/38 通过，含真实 rclone S3 PUT 的 SOCKS5 转发、代理拒绝后不访问可直达目标、代理关闭禁止启动上传、环境变量冲突及 FTP 直连。真实 R2 小文件上传、公开下载内容校验及临时对象清理通过。本机服务已按原 npm 命令重启，公网健康检查 proxy=true。此次执行代码仍全部位于忽略的 local-download-service/；Agent、Bridge、VPS 均未改动，无需为该本机策略重新部署它们。

## 网页资料库补充 · 2026-10-28

核对现有 r2-file-browser 的 tools/ 扫描和 UPLOADED 显示规则后，在本机服务新增上传后发布步骤：保留 firmware/ 原对象及机器人链接，通过同桶 R2 服务端复制生成 tools/firmware/ 对象，并添加 OS 描述及 SHA256 元数据。上传、复制各有持久检查点，重试复用已验证对象；网页接口确认收录后才返回成功。多占一份 R2 对象空间，不从本机重复上传大包，不批量改动历史文件。

本机完整测试 **47/47**，33.490 秒，日志 local-download-service/data/test-library-full.log。新增覆盖网页短暂不可用后的恢复、重启检查点、已发布对象变化、重复请求保留人工描述、服务端复制能力及链接编码校验。

真实端到端测试使用临时 FTP 的 **12,934 字节**测试 ZIP：本机上传真实 R2、确认服务端复制、查询正式网页 API、校验 source=r2/external=false（UPLOADED）、分别读取机器人及网页下载链接并核对 SHA256；两份临时对象已删除，ok=true、cleanup_ok=true。报告 local-download-service/data/library-smoke.json。未传输正式 OS 包；未改 r2-file-browser、Agent、Bridge 或 VPS。

本机服务已安全停止并按原 npm 命令重启加载发布配置；公网健康检查 HTTP 200，worker/ftp/disk/storage/proxy 全部通过。Python 编译检查、Git 忽略检查和 git diff --check 通过。

## 维护提示排查补充 · 2026-10-28

用户反馈本机服务、隧道、工具开关均开启，企微仍提示维护。实际检查确认本机及公网 readiness 正常，VPS 已更新固件代码、两个服务均运行、工具已保存为开启、模型配置正常，但 VPS `.env` 缺失 FIRMWARE_SERVICE_URL 和 FIRMWARE_SERVICE_TOKEN，因此 Agent readiness 始终失败。

此次通过 SSH 补齐 VPS 的三项 FIRMWARE 配置；token 仅通过 SSH 标准输入传递，未输出。原 `.env` 以权限 600 备份至 VPS `.data/backups/env-before-firmware-2026-10-28T14-24-05-179Z`，新 `.env` 保持权限 600。确认 Agent 无执行或排队任务、无固件流程后，仅重启 product-expert.service，未上传代码、改动 Bridge 或发送企微消息。

VPS 到本机公网 readiness HTTP 200，worker/ftp/disk/storage/proxy 全部通过。重启后的真实 Agent 机器接口用独立诊断身份执行“取消”入口检查，HTTP 200 返回“已取消固件流程。”，验证工具与 readiness 已放行，且未留下活动流程、未提交文件名或下载任务。用户可在原企微会话重新发送 `/firmware`。
