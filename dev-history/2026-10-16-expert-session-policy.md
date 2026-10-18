# 2026-10-16 ProductExpertCloud 默认技能与会话策略

实施目录：`/Users/patrickxu/ProductExpertCloud`，按用户在本聊天中的明确授权修改。未改动 pi-patrick 的实现、原始 patrick-agent 或 VPS。

- 优化两个 SKILL，移除旧平台 skill_read/file_search 等不可用入口及旧目录假设，保留产品血缘、来源层级、冲突提示、UMS 路由和知识只读约定。
- 通用模板放 resources，运行副本在 `.data/`，运行前后均不自动覆盖业务知识。旧 SKILL 备份至 `.data/maintenance-backups/2026-10-16-default-skills/`。
- UMS 原无 MEMORY，新增“暂无额外业务条目”的文件；产品 MEMORY 未编辑、未压缩或截断。每个用户请求重新读取两份技能和记忆；请求边界注入，当前任务内快照稳定。
- 最近五轮包含本轮；工具消息按轮保留；磁盘完整会话按最后活动时间保留 30 天。删除限于配置会话目录，保护同进程正在运行的 prompt，未实现跨进程锁，故目录需由单个服务进程持有。
- 模型 endpoint 测试全部为本机模拟，观察的是 SDK 实际请求；没有使用真实密钥或外部模型。首次测试发现 SDK user content 是结构化数组，修正测试读取方式后通过，并未用宽松断言跳过窗口检查。

验证：类型检查/构建、8 项本机行为测试、两个 SKILL 格式校验通过。真实产品回答准确率、实际 token 容量、Ubuntu 24 与 VPS 常驻服务尚未验收。全量 MEMORY 会占模型上下文；五轮不等于固定 token 预算，不静默截断。
