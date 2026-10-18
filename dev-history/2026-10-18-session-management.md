# 来源展示与会话管理

用户确认优化三个点：两个 Skill 默认不展示来源，左侧支持 rename/delete，右侧调试栏默认收起。

- Skill 仅调整最终回答的来源展示条件，仍要求内部检索核对、保留冲突和不确定性。两个 `.data` 副本修改前备份在 `.data/maintenance-backups/2026-10-18-source-display-003854/`；正文知识与 Memory 无变化。
- 后端 PATCH 保存 SDK session_info，DELETE 删除同一个 JSONL 并释放缓存；参数按会话 ID 解析，保持本机请求检查。运行、初始化及管理之间互斥；已删除 ID 在当前进程中保留 tombstone，防止异步旧请求复活。
- SDK 默认在首条 assistant 之前不写文件，所以空会话改名时保存公开 getHeader/getEntries 的 SDK 格式，然后释放对象，下次正常 open，避免修改 SDK 内部 flushed 字段。
- 前端用原生 details 菜单及 dialog，删除前明确提示数据范围。调试面板 hidden 默认值为 true，点击顶部开关才显示；窄屏可打开会话抽屉。
- 29 项本地测试通过；浏览器用隔离目录、模拟模型验证菜单、改名、刷新恢复、删除确认/取消和调试开关。没有删除用户原有会话或调用真实模型。

来源规则属于模型指引，未用前端正则强行裁掉引用，未实施真实模型质量评估。没有新增数据库、Context Token 统计或 OS 沙箱。
