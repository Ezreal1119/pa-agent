# OS 固件机器人流程

`/firmware` 是隐藏命令，不出现在欢迎消息或快捷命令菜单中，仅通过用户手动输入进入。普通 Web/企微聊天和 MCP 都不能直接启动下载。Agent Settings 的 Tools List 中有独立的 **OS firmware / firmware** 开关；旧设置没有此项时默认关闭。

## 使用

1. 发送 `/firmware` 后输入完整 OS 包文件名，或者发送 `/firmware 完整文件名`。允许省略 `.zip`。
2. 本机服务实时列出 FTP 真实文件，AI 从返回的候选中判断可能匹配。模型只持有候选选择工具，不能访问任意 FTP 路径或启动传输。
3. 多个候选时回复 `选择 1` 等序号。机器人显示完整文件名、路径、大小和差异，用户需核对日期、机型、地区及版本。
4. 回复机器人本次给出的 `确认 ABC123`，才创建下载并上传 R2 的后台任务。单独回复“确认”、旧确认码、其他用户的确认都不能启动。
5. 完成 FTP 下载、R2 上传及对象校验后，机器人返回实际下载链接。失败不会返回成功链接。

等待文件名、选择和确认各有 5 分钟有效期，查询匹配阶段最多 2 分钟。输入“取消”可退出未执行流程。执行后使用 `/firmware 取消` 请求停止，或 `/firmware 状态` 查看当前阶段。

群聊支持在单行固件输入首尾 @ 当前机器人，例如 `/firmware @AI Patrick`、`@AI Patrick /firmware`、`固件名 @AI Patrick`、`确认 ABC123 @AI Patrick` 和 `/firmware 取消 @AI Patrick`。Bridge 仅移除与配置显示名精确匹配的首尾提及，再进行原有校验；不会移除其他人的 @、文字中间的 @ 或前缀相似的名字。发起人、原群、确认码、引用/附件和单行限制保持不变，普通聊天及其他命令沿用原解析。

默认显示名为 `AI Patrick`，现有机器人无需新增环境变量。如果机器人改名，单机器人在 `.env` 设置 `WECOM_BOT_NAME=实际显示名`；多机器人分别在 `WECOM_BOTS` 条目设置 `name`，未设置时沿用默认名。SDK 文本回调不提供显示名对应的提及身份，此处按配置名称匹配，不从用户消息自动学习名称。更新该解析逻辑只需同步代码并重启 Bridge；不需重启 Agent、本机固件服务或隧道。

机器人按确认后的第 **1、2、3、5、7、10、15、20、30 分钟**主动通知当前下载或上传阶段；30 分钟后每 10 分钟一次。完成和失败不等通知时点，下一轮状态检查后立即投递。后台状态通常每 5 秒检查一次，通知通过主动消息发送，不依赖原消息回复窗口，不让 AI 持续在线。

## 单任务和维护

- 所有用户、群聊和机器人共享一个固件名额，从进入 `/firmware` 开始占用，其他请求回复“当前有固件任务处理中，请稍后再试”。普通聊天的并发不受此限制。
- 输入/确认超时、未找到候选、取消预览，以及执行成功、失败或确认取消后释放名额。
- 工具关闭、本机服务停止、隧道断开、FTP/磁盘/上传配置不可用或模型未配置时，入口回复“固件功能维护中，请稍后再试”。
- 关闭工具禁止新请求和新提交；已经被本机接受的任务继续执行、查询和发送结果。关闭前已确认但尚未被本机接受的请求会取消，不悄悄新建任务。
- 本机断开不会释放正在执行任务的名额。云端保留任务身份，恢复后查询同一个任务，避免重复下载上传。
- `/clear` 清理聊天历史，不等同于取消已经确认的固件任务。

## 本机

实际本机代码位于 `local-download-service/`，整个目录被 Git 和 Docker 忽略，不随主项目部署。只处理 `/FTP7/OS/` 中的 OS ZIP，不接入 RD/PRO 或海外 SFTP。

在项目根目录分别启动两个进程：

```sh
npm --prefix local-download-service start
cloudflared tunnel run urovo-tech
```

停止本机固件服务：

```sh
npm --prefix local-download-service stop
```

隧道在本机 `~/.cloudflared/config.yml` 中为 `/firmware-api/*` 增加专用 ingress，参考 [规则示例](../deploy/cloudflared-firmware-ingress.example.yml)。旧 APP 仍转发到 4824，旧 Agent 转发到原端口，不整体替换。

本机新规则转发到 `http://127.0.0.1:8765`，设置 `httpHostHeader: 127.0.0.1:8765` 和 `disableChunkedEncoding: true`。本次网络环境中 QUIC 发生重连，已将本机隧道顶层配置改为 `protocol: http2`，启动命令不变。修改前的配置备份在被忽略的 `local-download-service/config/cloudflared-before-firmware.yml`。

公开固件 API 仅允许健康检查、候选查询、确认提交、状态查询、按幂等请求查询及取消，不开放本机 `/v1/shutdown`、重试或事件管理入口。所有公开固件接口都需要独立的本机服务 Bearer token；它不是旧 APP 的 Mobile API Token，也不是 Bridge Token。

本机 `/firmware-api/health` 会检查 worker、FTP 连接、剩余磁盘及 rclone 配置，短暂缓存 5 秒；不保证远端 R2 在整个后续传输期间持续可达，实际上传错误由任务状态反馈。

本机 R2 上传和对象校验强制使用旧项目同一份 `/opt/homebrew/etc/proxychains.conf` 的 `strict_chain` 和本机 SOCKS5 代理（当前 `127.0.0.1:7897`）。服务不依赖启动终端的代理环境变量；rclone 子进程会覆盖代理变量、清空 `NO_PROXY`，并显式传入原生 `--http-proxy`。代理不通、配置缺失或链模式不符合要求时禁止直连上传，健康检查失败时机器人显示维护提示。FTP 查询与下载在未包裹代理的服务进程中保持直连。

原始 Proxychains 配置不修改。为避免把“连接本机 SOCKS5 代理”再次通过同一代理转发，本机服务在被忽略的 `data/proxy/` 中生成专用副本，仅增加代理自身回环连接的豁免；R2 HTTP(S) 仍由 rclone 原生参数强制送往同一个代理。此配置及本机执行代码不上传 VPS；启动命令不变。

无需手动给 `npm start` 再套一层 Proxychains，也不需要先 export 代理变量。原生参数依据 [rclone 官方代理说明](https://rclone.org/faq/#can-i-use-rclone-with-an-http-proxy)；本机已通过真实 S3 上传代理测试、禁止直连回退测试及真实 R2 小文件测试。

## 网页资料库显示

本机上传完成后，将同一个 R2 桶内的 `firmware/<文件名>` 用服务端复制发布到 `tools/firmware/<文件名>`。现有 `r2-file-browser` 网页直接列出 `tools/` 下的对象，因此新固件能被搜索、显示和下载，标签沿用 **UPLOADED**。此步骤在 R2 内多保留一个对象，不从本机重新上传文件。机器人仍返回原来的 `/firmware/<文件名>` 链接。

发布配置仅保存在被忽略的 `local-download-service/config/settings.json`：

```json
{
  "library_r2_destination": "r2:firmware/tools/firmware/",
  "library_public_url_base": "https://temp.patrick-shenzhen.org/tools/firmware/",
  "library_api_url": "https://tool-files.patrick-shenzhen.org/api/files"
}
```

服务校验复制后的名称、大小和 SHA256 元数据，再查询网页接口核对来源、大小和下载链接，全部通过才把任务标记为成功。原上传和网页发布分别保存检查点；网页暂不可用时重试查询，不重复下载、上传或复制已经校验的文件。相同内容已存在时复用对象并保留已有的人工描述。

网页发布、校验和接口查询沿用强制代理。无需修改或部署 `r2-file-browser`、Agent、Bridge，也无需更改 VPS 的原下载链接配置。本次只改变后续固件任务的行为，未批量发布历史对象。

## VPS 上线（管理员手动执行）

本轮不提交、不上传代码，不连接或部署 VPS。管理员上传主项目代码后：

1. 在 VPS 被忽略的 `.env` 中增加：

   ```ini
   FIRMWARE_SERVICE_URL=https://urovo-tech.patrick-shenzhen.org/firmware-api
   FIRMWARE_SERVICE_TOKEN=本机local-download-service/config/api-token中的值
   FIRMWARE_PUBLIC_URL_BASE=https://temp.patrick-shenzhen.org/firmware/
   ```

   不上传整个本机服务目录，不把 token 写入 Git。既有 `WECOM_API_TOKEN`、机器人配置和主动消息权限继续沿用。

2. 安装项目锁定依赖、构建主项目：

   ```sh
   npm ci
   npm run build
   ```

3. 分别重启主 Agent 和 Bridge：

   ```sh
   systemctl restart product-expert.service
   systemctl restart wecom-bridge.service
   ```

   沿用你现有的 root/专用用户部署方式，无需新建 systemd timer 或修改原 unit。新模块只在既有 `.data` 下落盘。

4. Web 的 Agent Settings > Tools 中打开 **Download and upload OS firmware / firmware** 并保存。旧设置默认关闭，配置凭据不会自动启用工具。
5. 保持本机两个进程运行，在真实企微发送 `/firmware` 验证完整交互，再按真实文件名及本次确认码启动任务。

如果主 Agent 升级时 Bridge 已经启动，Bridge 会重试发现固件通知能力；服务恢复后无需依赖用户重新发送普通聊天才能投递积压结果。

## 状态与恢复

- 云端：`.data/firmware/state.json`，包括全局占用、操作者身份、真实候选快照、确认码、消息去重、原任务 ID、已通知的时点和通知 outbox。事务使用跨进程锁与权限 600 的原子写入。
- 本机：`local-download-service/data/jobs.sqlite3`，持久化任务和幂等请求。提交固定 `upload=true`，使用 `firmware:<云端流程ID>` 作为幂等键。
- POST 结果丢失时，云端先按幂等键查询是否已接受，再决定是否重发；重复请求不会创建第二个本机任务。
- Bridge：既有 `.data/wecom/bridge-state.json` 中保存每条固件通知已发送的文本片段。发送完成后确认 outbox；ACK 丢失或重启时不重复发送已记录片段。未确认的通知租约最长 60 秒。
- 网络恢复时合并错过的进度时点，只通知当前进度；不会集中补发一串历史百分比。
- 本机任务 404、结果包名/大小/来源不一致、返回链接不符合约定时，保留占用并提示管理员，不猜测任务结束、不自动再开第二个请求。

平台确认发送到本地落盘之间仍有崩溃窗口，因此不宣称企微消息严格 exactly-once。若本机任务数据库被删除或服务地址换到另一实例，应先由管理员确认原任务已停止，再修复任务记录；不能盲目清空云端占用。

## 验证

```sh
npm run typecheck
npm test
npm --prefix local-download-service test
```

根目录测试覆盖真实 Web/Bridge API、SDK 的模型工具调用、命令强制入口、开关、身份与确认码、单名额、各进度时点、断线保留、幂等恢复、通知租约和投递检查点。本机测试覆盖真实本机 FTP 和 rclone，以及公开接口白名单、健康检查和幂等查询。

真实企微主动消息、VPS 的网络和环境配置仍需管理员部署后验收；本机模拟通过不代表 VPS 已上线。本次没有为了联调而启动第二个真实机器人连接，避免与 VPS 现有 Bridge 抢占同一机器人。
