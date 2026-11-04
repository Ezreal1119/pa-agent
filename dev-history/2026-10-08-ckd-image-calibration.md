# 2026-10-08：参考图数学校准（人工标签不进入提示词）

## 决策与边界

用户选择用人工评分拟合参数，参考数据不进入提示词。固定 `subject-framing-v2` 视觉提取器，新增独立数值版本 `framing-numeric-v1`，避免评分公式调整使图片观察缓存失效。通用 Agent Core、tools、五阶段业务脚本与旧 patrick-agent 均未修改。没有新增依赖。

视觉仍只得到当前图片及固定提示词，不得到文件名、人工分、其他参考图或拟合参数。原始分析的 imageType、confidence、boundingBox、subject/reason 保留；拟合只使用量化几何特征与固定图片类型，自由文本用于解释，不从描述里猜数值 offset。将来增加紧凑/分散等新结构字段或改变提示词时，需要新的提取版本并重新分析/校准。

## 评分

旧的“占比÷类型阈值”只保留为原始 V2 几何诊断，不再是最终分。新版更侧重边缘：

- E = (max(left+right, top+bottom) + max(left,top,right,bottom)) / 2。
- A = 1 − bboxAreaRatio，框内必要间隔不扣分。
- raw = 100 − edgeWeight×E − areaWeight×A + typeOffset + bias。
- final = round(clamp(raw,0,100))，低于 80 提醒，80 不提醒；低置信度/unknown 不计分。

默认边缘权重 80、面积权重 15、偏移 0；diagram/scene 默认 +5，object/screenshot 为 0。active 参数匹配观察版本与实际模型才应用。返回 baseScore/final score/scoreBreakdown/calibrationId/scoreVersion/reminder；有效缓存重新计算分数，不重复识别。SOP 图片检查固定一次参数快照，完成旧任务不追溯变更。

## 校准与接口

独立目录 `.data/ckd/image-calibration/samples/`，命名 `<0..100>-<name>.png|jpg|jpeg`。POST `/api/images/calibrate` 接受空 JSON 返回 202+job；GET `/api/images/calibration` 查询目录/参数；GET `/api/images/calibration/jobs/:id` 查询状态、进度及报告；POST `/resume`、`/cancel` 支持重启后显式继续及取消。

扫描当前全部参考图，仅新 Hash 发视觉请求。相同 Hash 相同分去重，不重复权重；不同分冲突，不替换 active。改名改分复用观察缓存，移走后下次不参与。校准不拿上次最终分做拟合输入，只用原始特征。处理前后对参考集合/文件 Hash 复核，阻止外部修改期间生效。拒绝符号链接、子目录、非法分数/文件名、超限图片。

有界最小二乘确定性坐标搜索，加入轻微正则项，限制边缘权重 40–160、面积 0–20、全局偏移 ±25、类型修正 ±8。少于 8 张仅拟合全局偏移，8 张起拟合权重，某类型至少 4 张才拟合类型修正；少于 12 张标记实验性，不声称独立准确性。12 张起执行确定性留出验证，再用全体拟合 active 参数。留出 MAE 比默认规则增大超过 0.25 时保留旧参数。

误差分开报告训练 MAE、有符号偏差、最大绝对偏差与留出误差；逐图输出人工分、默认基础分及拟合分。错误、冲突、混合模型或校准途中参考集变化不替换现行版本。每次激活先保存 versions/<id>.json，再原子替换 active.json。任务落盘，跨进程独占校准锁、PID 恢复、取消信号及每模型请求超时沿用图片检查器。失败视觉请求不存成功观察缓存。

## 验证

- typecheck、build、全部 87 项测试及 JS 语法/diff 空白检查。
- 新增 10 项校准测试：拟合及参数边界、确定性、标签不入提示词、改名改分/新 Hash/移除/去重、冲突与无效样例保护、并发/取消/超时、重启与引用集合变化、版本/模型隔离、API、留出性能变差拒绝生效。
- 测试数据和模型均在临时目录注入，未全量检测正式 Library。

## 本机实测

将用户明确给 70 分的 Downloads 图片复制为 `samples/70-P1.png`，原图不改，Hash `3bf6ea9327fcf2d881968df8c9bc24112f8b716f5969936fb45c34bea5f451e1`。

复用此前真实 qwen3.8-flash 的 V2 观察（left=.06/top=.25/right=1/bottom=.82），两次实际校准和上传接口检查均成功，**新增视觉请求 0 次**。新版默认基础分约 65.84（输出 66），单样例拟合 bias=+4.16，最终输出 70，reminder=true，cached=true。此前 82 分来自历史占比公式，不能把历史公式分数与新版基础分混为同一口径。

任务 ID 为 `639484d5-be8c-4e46-979b-b2e11d0ce092`、`7c6a7d57-635f-4668-a2fa-68ddf2ce0767`。报告 `.data/ckd/image-calibration/smoke/report.json`。两次均警告只有一张有效样例、只拟合偏移、尚无独立验证。这只证明人工锚点接入与缓存/数值流水线成功，不证明其余图片准确。

此前全量摘要任务已结束后，确认没有正在执行的 SOP 或维护，才重启新后端。4317 为主服务，4318 保留此前单图测试地址，两者读写同一份任务/缓存/参数；锁阻止并发修改。
