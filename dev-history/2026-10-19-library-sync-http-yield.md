# Library 同步期间管理员网页失去响应

VPS 的一次 Library 同步进行到图片描述与摘要阶段时，Node 服务进程持续占用 CPU；`/admin/` 的本机上游和公网入口均超时。系统仍有可用内存、swap 未被使用，Nginx 正常；该同步自然完成后网页恢复。问题是后台批处理与 HTTP 共用 Node 事件循环，连续复用缓存时没有真正交还事件循环。

在译文同步、图片 Hash 分组/评分、历史摘要导入和摘要目标循环的每项之间，使用 `setImmediate` 让出一次事件循环，再检查取消信号。没有额外 worker 进程或常驻内存；不改变图片、译文和摘要的产出规则。一次大文件的同步读取/Hash 仍可能短暂阻塞，这次修复针对实际观察到的数百项连续处理。

验证：本机 `npm run typecheck`、`npm run build`、`npx tsx --test --test-timeout=30000 tests/ckd-library-sync.test.ts`、`npm test` 均通过；完整测试 187 项通过、2 项因平台条件跳过、0 失败。新增测试直接运行全部命中缓存的摘要维护，确认完成前 HTTP 所需的事件循环回合已经执行，且摘要仍全部复用。

VPS 更新前确认无正在运行的 Library 同步、服务和管理员入口正常；旧版六个文件备份于 `/opt/pi-patrick-backups/library-sync-http-yield-20261019/`。只同步三个修改后的 TypeScript/JS 对及新的 `library-yield` TypeScript/JS 文件，不传 `.data`、环境变量、桌面端或其他源码。VPS `npm run typecheck` 通过；重启 `ckd-sop.service` 后，服务 active，本机和公网 `/admin/` 均返回 302 登录跳转，响应约 0.01 秒。此时没有在正式 Library 再发起全量同步，在线同步期间的稳定性仍需下一次实际同步观察。
