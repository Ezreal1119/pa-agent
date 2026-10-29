# 2026-10-29 · 固件自然语言条件查询

## 行为

按用户确认的新规则，保留隐藏 `/firmware` 入口，将原完整文件名模糊匹配改为 AI 从原话提取 SQ 型号、六位 YYMMDD 日期和两位 index，再由本机代码执行三个条件同时匹配。完整型号必须一致，日期和 index 按相邻 `_YYMMDD_NN` 段匹配，不将前面的 S01/S02 当序号，也不默认最新日期或 index 01。

只有唯一匹配进入原确认流程。零匹配返回未找到并结束；多匹配返回总数、文件名及路径后结束，不再让用户选择候选，也不因完整文件名精确匹配而隐藏其他同条件包。输出最多展示 12 项，匹配总数在截断前统计。缺字段、提取值不在原话、无效日期、目录或文件信息不完整时不进入下载，结束并释放名额。

用户确认规则、单任务名额、代理、上传及网页发布、进度通知保持原实现。旧版未确认流程启动时结束并提示重发；已经确认并提交或运行的任务仍保留身份和幂等恢复。

## 改动

- Agent：query.ts 校验条件、来源和文件名边界；matcher.ts 中的模型会话改为受约束 extract_firmware_query 工具，只能提取条件，没有 FTP 或传输权限；service.ts 负责三种匹配数量分支与升级处理。
- LocalFirmwareClient：提交 criteria，并校验协议、候选条件、计数、截断和完整性。旧服务不能处理新请求时失败，不回退模糊匹配。
- 被 Git/Docker 忽略的本机服务：search_terms 按原索引精确型号目录遍历，完整计数后限制元数据和输出数量；公开 search 接口增加 criteria 分支。旧 filename 查询仅保留给本机 CLI/既有测试，新机器人不调用。
- Bridge 命令入口和上一轮群聊 @ 解析不改动。文档同步更新部署次序，没有新增依赖或必填环境变量。

## 验证

- 主项目 `npm test`：**581/581**，零失败/跳过，69.24 秒；日志 `.data/firmware-criteria-full.log`。构建与 Python 语法、git diff --check 通过。
- 本机 `npm test`：**52/52**，34.56 秒；日志 `local-download-service/data/test-criteria-full.log`。含真实临时 FTP 的唯一查询及下载、完整型号和日期/index 边界、15 个结果截断前计数、目录失败不误判唯一、无效条件拒绝；保留代理、缓存恢复和网页发布回归。
- 新增主项目覆盖原自然语言完整传递、先提取后查询、缺失/虚构字段不查 FTP、多匹配即使有精确文件名也结束、零匹配/不完整目录结束、原群原用户确认与取消、协议旧版拒绝、旧流程升级及已接受任务保留。
- 本机配置的真实模型 3/3：用户例句正确提取 SQ68MB/260422/01；“最新固件”缺日期和序号返回 null；完整文件名 S01 与日期后的 02 正确区分。报告 `.data/firmware-criteria-live-results.json`。
- 真实 FTP 查询 SQ68MB/260422/01 有两个结果：普通 rel.zip 与 rel_uFWsign_VendorEN.zip。隔离本地 FirmwareService + 真实模型 + 新本机 HTTP API 完成自然语言查询，返回两项并释放名额，未确认或启动下载。报告 `.data/firmware-criteria-real-ftp.json`、`.data/firmware-criteria-e2e-result.json`。

## 运行与边界

确认本机原任务已成功结束后，按原 stop/start 命令重启本机固件服务，新 criteria 接口已验证 HTTP 200。本机服务代码继续被 Git 忽略。此次没有访问 VPS、修改实际 .env、提交/上传代码、连接或发送企微消息，也没有新建生产下载/上传任务。

管理员同步主项目后需构建并重启 product-expert.service；若尚未部署此前群聊 @ 修复，还需重启 wecom-bridge.service。本机服务已更新，无需修改 FTP 路径、代理或 cloudflared 规则。确认仍要求原确认码，本轮未将“包含确认”作为放行条件。
