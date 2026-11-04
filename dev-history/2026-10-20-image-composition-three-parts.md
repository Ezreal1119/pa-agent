# 图片构图与留白三项评分（2026-10-20）

需求：仅保留空间利用、背景干扰、主体突出，分别占构图总权重 40% / 40% / 20%。空间利用按无关留空占比分档；超过 70% 时整张图片不得高于 60 分。

实现：`src/ckd/image-framing.ts` 将原五项改为三项；空间利用按 `unrelatedBackgroundRatio` 在 30% 与 50% 边界计算 0% / 25% / 50% 扣分，>70% 仍在最高扣分档，同时 `src/ckd/image-assessment.ts` 在最终总分施加固定 60 分上限。原背景干扰严重程度和主体突出严重程度/主体长边校验继续使用。初检与保守复核沿用已有视觉观察，取两次无关留空的较高估计，不把内部有用间隙算作空白。新增 UI 与复核报告说明，数值版本提升为 `seven-numeric-v8`。旧成功观察仍复用，旧 offset 不自动作用于新分数。

验证：本机 `npm run typecheck`、`npm test`（203 通过、2 跳过）、`npm run build`、`node --check resources/ckd-ui/app.js`、`git diff --check` 通过；定向测试覆盖 30%、50%、70% 阈值、缩放权重、关闭原可配置留白上限后仍执行 60 分上限、缓存复用及完整 CKD 工作流。未做真实视觉模型准确率评估；占空比例仍为模型估计值，实际图片的临界判断需人工核对。

VPS 部署：先将旧实现备份到 `/opt/pi-patrick-backups/image-composition-20261020/code-before.tar`，仅同步本次源码、编译产物、管理页与文档，未覆盖 `.data`/`.env`。服务器 `npm run typecheck` 通过；定向测试 29 通过，另 2 个未登录 API 测试在生产管理员鉴权下返回 401，与测试预期的参数错误 400 不同。重启 `ckd-sop` 后服务 active，编译模块报告 `seven-numeric-v8`，本机与公网 `/admin/` 均返回登录重定向 302，登录页 200，未登录管理 API 401。服务重启使原内存登录会话失效。
