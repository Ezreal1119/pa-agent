# 2026-10-18 企业微信接入

落代码目录：`/Users/patrickxu/ProductExpertCloud`。`patrick-agent` 仅为先前调查的只读参考，本次未修改、构建或启动该项目。没有写入 `pi-patrick`。

实现位置：

- `integrations/wecom-bridge/`：独立长连接入口、消息/媒体协议、Agent HTTP/SSE 客户端、持久状态与调度。
- `src/web/bridge-access.ts`：专用凭据、企微 session 归属登记；browser/machine 权限分开。
- `src/web/run-gate.ts`：所有 HTTP run 共用的有界并发/等待与取消。
- `src/web/server.ts`：复用原有 session、工具、文件和 SSE，不新建第二套 Agent。
- `deploy/product-expert-wecom.service`：root sidecar；现有主服务增加 Wants，桥接 PartOf/After。
- `.env.example`、`docs/wecom-bridge.md`：配置示例与按用户当前 root 方式部署的完整步骤。

新增19项测试分为协议/加解密/流/状态存储、调度/恢复、真实HTTP权限/全局队列、真实SDK与文件工具端到端。核心点：单聊隔离、群共享、多bot隔离；同群串行/不同会话并发；重复消息重启后不重复执行；文件暂存重启不再依赖临时下载链接；多文件只补发剩余产物；浏览器和企微共用容量，排队可取消；最终文字不含文件名仍回传生成XLSX。端到端真实执行PDF/DOCX/PPTX读取及Excel读取、补丁与校验；检查目标数值、样式/公式保留和原件不变。

测试日志统一 `.data/debug/wecom/`，运行状态/密钥继续 Git 忽略。业务技能、MEMORY、知识 Markdown、现有会话与本机 `.env` 均未修改。没有启动本机4321或连接任何真实Bot；关闭开关的 CLI 冒烟正常退出。真实供应商模型质量、企微认证/群@回调/主动回复与VPS systemd实际启停留给部署验收，不能将模拟传输测试当成已上线。

最终本机 `npm test` 100/100 通过（19项企微相关测试），约15.3秒；构建与 diff 检查通过。`npm run test:wecom` 可单独执行相关测试。Linux 进程锁使用 boot ID 与进程开始时间避免重启后 PID 复用误判，只有 Linux 条件分支能验证该路径，未冒充本机已做 Linux 验证。

后续修正：用户改为分别管理 Agent 和 Bridge，最终 unit 为 `deploy/wecom-bridge.service`，与 `product-expert.service` 不互相依赖或传播启停，仅保留同时启动时的 After 排序；支持分别开机启用。上方联动描述是本轮早期状态，现已由此修正取代。文档/配置引用与 diff 检查通过，本次没有改问答/工具实现或重跑完整测试。
