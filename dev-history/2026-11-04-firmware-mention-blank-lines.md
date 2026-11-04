# 固件输入允许机器人提及单独一行

用户在群里发送完整固件名后空行再 @AI Patrick，旧 Bridge 检查原始消息是否含换行，直接拒绝而没有进入固件查询。

- 群内首尾机器人提及的边界支持 LF、CRLF、CR 和 Unicode 换行；先清理首尾空白及精确配置名的提及，再检查固件正文。
- 文件名、自然语言需求、选择、确认、取消和状态均可与 @机器人分行。清理后的正文保持原样发给 Agent，不合并正文内的多条内容。
- `/firmware` 强制入口、机器人/发起人/群范围、确认码、原消息长度、NUL、纯文本和引用限制继续生效。其他提及和正文中间的提及不移除，普通聊天和其他命令不做额外清理。
- 仅改 Bridge 的命令解析，无 Agent 或本机服务协议变化。部署后重启 `wecom-bridge.service` 即可。

验证：`node --check integrations/wecom-bridge/commands.mjs` 通过；`node --test tests/firmware*.test.mjs tests/wecom-commands.test.mjs tests/wecom-bridge.test.mjs` 共 61 项通过，零失败/跳过。覆盖用户截图的实际文件名、五种换行、自定义机器人、双边提及、非法多行/引用/附件，以及真实本机 Web API + Bridge 的选包、确认、取消和身份隔离。日志 `.data/firmware-mention-newlines-tests.log` 不提交。

未访问 VPS、未读写实际 `.env`、未发送真实企微消息，未下载/上传真实固件。
