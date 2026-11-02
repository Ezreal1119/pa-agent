# Library 独立导入费用账本 EROFS 修复

用户提供的报告显示 Library 定时导入在 classifying 阶段写 `.data/usage-ledger/*.tmp` 时收到 EROFS，导致后续文件未尝试。原因是增加模型费用计量后，没有同步独立服务的 `ProtectSystem=strict` 写入范围；默认 proper-lockfile 还会在目录外创建同级锁。

## 改动

- `UsageLedger` 的跨进程锁统一为账本内 `.accounting.lock`，使用原有安全路径校验、互斥与心跳机制。Agent 的结算/汇总和 Library CLI 使用同一锁；不降级为无锁，也不忽略费用写入错误。
- 新装服务模板只增加账本目录的 `ReadWritePaths`，其余保护保持。
- 提供独立 additive drop-in `deploy/product-expert-library-import-usage-ledger.conf` 给现有安装，保留服务器已配置的 User/Group、资源限制和 timer。
- 文档补充三目录初始化、既有 VPS 的增量安装命令、同运行账号要求及锁路径切换注意事项。升级时停止旧账本调用进程后构建，避免新旧锁协议混用。

## 验证

- `npm run build` 通过。
- `node --test tests/usage-ledger-sandbox.test.mjs tests/sync-notifications.test.mjs tests/library-import*.test.mjs`：42 项通过，零失败/跳过，日志 `.data/usage-ledger-fix-tests.log`。
- 4 项新增回归：根据新装 unit 和旧 unit + drop-in 的实际写入白名单运行 Node 权限受限子进程，验证只读父目录中的分类与记账；缺账本权限时在模型调用前拒绝；主进程/受限导入进程共享锁并保留费用区间边界；内部锁软链接被拒绝。
- 使用实际本机文件写入限制与进程间互斥，模型回复为本地 fixture。未在 Ubuntu systemd mount namespace 实跑，未请求真实模型或下载文件。
- 未访问 VPS、未读取/改写真实 `.env`、未安装/启停真实服务、未提交/上传代码。
