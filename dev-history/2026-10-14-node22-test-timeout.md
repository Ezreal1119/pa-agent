# 2026-10-14：Node 22 图片测试与下载测试超时

Ubuntu VPS 运行串行测试时，桌面下载用例的初始化登录共用 100 毫秒请求时限，登录在负载下超时；图片用例的受控模型故意不返回，用于验证超时和取消。`AbortSignal.timeout()` 的内部计时器不保持 Node 22 事件循环，因此等待的 Promise 尚未结算，测试进程就取消该文件剩余用例。后续取消不代表对应图片评分或生成逻辑均失败。

把下载测试的登录准备阶段与被测的短时限请求分开，流式下载用例的 HEAD 容忍度从 100 毫秒调到 1 秒。三个图片模型等待点使用保持进程存活的计时器，并在成功、失败、取消时清理；原 5 分钟默认超时、请求取消、缓存和评分行为不变。改动位于 `desktop/test/download.test.cjs`、`src/ckd/image-quality.ts`、`src/ckd/image-assessment.ts`、`src/ckd/image-operation-focus.ts`。

验证在临时测试数据上执行，未触碰正式 Library、模型密钥或云端任务。Node 22 下针对四个相关文件的 32 项测试全部通过；Mac 使用 Node 22.23.3 的完整 179 项通过，`npm run typecheck`、`npm run build` 和 diff 检查通过。

Ubuntu VPS 的旧源文件备份位于 `/opt/pi-patrick-backups/node22-test-fix.WVrfRt/before.tar`，只同步上述四个代码文件及文档；没有同步 `.env`、`.data` 或 `node_modules`。服务器 Node 22.23.2 重新 typecheck/build，串行完整 179 项测试通过，0 失败、0 取消。`ckd-sop` 服务重新启动并保持 active；本机 `/api/status` 返回 `libraryReady:true`，公网 `/api/client/status` 未登录返回预期 401。桌面包不因这次测试修正而需要重新打包。
