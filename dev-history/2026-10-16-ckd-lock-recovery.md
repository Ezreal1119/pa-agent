# 2026-10-16：CKD 锁在 VPS 重启后误判占用

Ubuntu VPS 10:26 强制重启后，10:19 建立的 Library 锁和任务锁仍记录 PID 789。该 PID 已被阿里云服务线程复用，服务账号调用 `kill(pid, 0)` 返回 `EPERM`，原代码把它当作仍在工作的 CKD 进程，桌面端新建任务报 `Library/task is busy in another process.`。检查服务端仅有一个 CKD Node 服务进程，两个锁目录修改时间均早于 `/proc/stat` 的本次开机时间；据此只清理了这两个失效锁，未改 Library、任务状态或其他数据。

`src/ckd/lock-owner.ts` 为 Linux 锁记录增加 boot ID 和 `/proc/<pid>/stat` 的进程启动 tick。回收时先核对 PID，再核对 boot ID 与启动 tick；对旧格式 PID-only 锁，若锁目录早于本次开机，按失效处理。Mac 等非 Linux 系统保留原 PID 存活判断。`library-lock.ts` 与 `store.ts` 共用判断，分别覆盖 Library/图片维护锁和 SOP 任务锁。

验证命令：`npm run typecheck`、`npm run build`、`node --import tsx --test tests/ckd-lock-recovery.test.ts tests/ckd-runtime.test.ts`、`npm test`。Linux 特有的复用进程号和旧锁回收场景在服务器临时目录验证；实际 Library 锁可由 `ckd-sop` 服务账号成功获取并释放。未调用模型，未改桌面包。

本机完整测试 180 通过、2 个 Linux 专用用例跳过；Ubuntu 目标测试 3/3 通过。仅将本次修改的源码、编译结果、测试与记录用 rsync 同步到 `/opt/pi-patrick`，没有同步 `.data`、密钥或桌面包。等待当前运行任务自行释放锁后重启 `ckd-sop.service`；重启后服务为 active，本机 `/api/status` 返回 200，Nginx 未登录的 `/api/client/status` 返回预期的 401，服务账号能获取并释放实际 Library 锁。重启前那项运行任务的最终状态为 cancelled；本次操作没有主动取消它。
