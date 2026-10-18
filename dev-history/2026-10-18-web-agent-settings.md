# Web Agent 设置

目标与实现均在 `/Users/patrickxu/ProductExpertCloud`。本轮未读写 patrick-agent 或 pi-patrick，未修改用户实际 .env、知识或 MEMORY。

模型连接表单移除，原 POST /api/config 返回 410；模型配置仍启动时从 .env/进程环境或显式服务启动选项读取。Agent 设置保存全局 effort 与文件工具总开关/六个独立布尔开关至 Git 忽略的 .data/web-agent-settings.json，不存密钥，不随会话过期清理。初始开关沿用环境配置，首次 low；存储后覆盖该初始默认。

GET/PUT /api/agent-settings 与原认证、Token、Host/Origin 策略一致。任何运行、初始化、上传或会话变更期间拒绝修改，成功后释放 Agent 缓存，按原会话 ID 重建工具集；不清历史记录或附件。SDK 只注册启用工具，FileTools.execute 也校验开关；按启用项加载文件 Skill。总关恢复原五工具，保留单项选择；历史下载和清理保持有效。Web 发 run 时不再携带 effort，服务端采用全局值；显式 API effort 兼容保留。

验证：完整 npm test 59/59，通过类型构建和实际 SDK HTTP 请求检查；新增安全存储用例后另跑 Web 套件，结果见 .data/debug/agent-settings-web-tests.log。测试覆盖新建及恢复会话工具集和 high/off 生效、重启保留、保存不丢历史、直接执行关闭工具拒绝、身份/CSRF/字段与供应商限制、旧模型编辑接口停用、.env 保留和链接/格式拒绝。

浏览器 4322 隔离服务使用一次性 settings-test 账号及本地模拟模型，切换 high、关闭 image_read、总关后重开保持 image_read 关闭，保存并刷新确认持久化；截图 .data/debug/agent-settings-ui/settings.png。全局设置测试仅落在该隔离目录，未替用户改变实际强度或单项偏好。最终 4321 重启加载新代码，模型连接值不变。未调用真实供应商或做 VPS 部署，本轮变动不涉及解析 worker。
