# UMS 普通 Skill

实现位于 `/Users/patrickxu/ProductExpertCloud`。ums-expert 从默认每轮完整注入列表移除，登记为 SDK 的可选普通 Skill，路径指向 `.data/ums-expert/SKILL.md`。只有名称/简介/路径用于发现，正文由 read 按需加载；不再读取/要求专属 MEMORY.md，旧文件保留。未移动 references 或删除业务资料。

urovo-product-expert 的默认 SKILL/MEMORY 加载、每轮热更新和同轮快照不变。额外 memory/MEMORY.md 与 memory 工具、五轮窗口、会话/附件清理和工具开关均沿用原逻辑。Web 检查改为一个默认 Skill，并显示 UMS 按需状态。

UMS 模板及部署 SKILL 已按 skill-creator 规范更新。旧文备份 `.data/maintenance-backups/2026-10-18-ums-on-demand/`；该目录 protected-sha256.json 记录产品 SKILL、产品 MEMORY、旧 UMS MEMORY、extra MEMORY 的摘要，完成后验证相同。

验证：npm test 62/62，通过构建和实际 SDK 发送的本地模拟 HTTP 请求；新增按需读取、UMS MEMORY 缺失及 UMS 整体未部署用例。原每轮快照/七轮/恢复测试继续验证默认产品资源及额外记忆。模板与实际 UMS SKILL 均通过 quick_validate.py。未调用用户真实模型，未修改源 patrick-agent、pi-patrick、实际 .env 或任何业务记忆正文。
