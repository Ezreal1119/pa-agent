# 2026-10-29 · 固件群聊 @提及解析

用户在群中发送 `/firmware @AI Patrick` 和 `SQ68MB_EN_XX_WE__DS_FI_S01_U_260422_01_rel_uFWsign_VendorEN @AI Patrick` 后反复收到文件名无效提示。原 Bridge 把机器人显示名当成固件输入的一部分，触发文件名中的 @ 字符检查；这不是禁止群聊。

## 修改

- 仅群聊的固件入口及发起人的后续输入清理首尾、独立分隔的当前机器人 @提及；支持命令、文件名、选择、确认、状态和取消，保留原单行纯文本、引用、长度及身份校验。
- 名称按配置精确匹配并转义正则特殊字符，接受空格、制表符及中文环境常用 Unicode 空格分隔。不删除其他人的 @、名字前缀、嵌入内容或中间的提及。
- SDK 文本类型不提供显示名对应的提及身份，故不从消息自动推断机器人名称。显示名默认 AI Patrick；单机器人可选 WECOM_BOT_NAME，多机器人各项可选 name。Bridge 按接收机器人选择配置，普通聊天、私聊和其他命令沿用原逻辑。
- 文档和 .env.example 同步说明。/firmware 继续隐藏，不加入欢迎语。

## 验证与边界

`npm run build`、Bridge 解析语法检查通过。`node --test tests/firmware-wecom.test.mjs tests/firmware.test.mjs tests/wecom-*.test.mjs` **120/120** 通过，零失败或跳过，约 16.35 秒；日志 `.data/firmware-group-mentions-tests.log`。

新增覆盖截图原始输入、前后提及、Unicode 空格、非当前机器人/其他用户/其他群、带正则字符的机器人名称、私聊和普通聊天不变、原引用/附件/多行/长度限制。真实本地 Web API + Bridge 配合模拟固件服务验证群内选包、确认、运行中状态与取消、通知路由到原群，以及配置自定义名称确实传入解析。

本轮仅本地修改与测试，未访问或修改 VPS/.env、未重启真实 Bridge、未连接企微或发送消息、未提交下载上传任务。管理员同步代码后仅需重启 wecom-bridge.service；当前名称 AI Patrick 不需要新增配置。
