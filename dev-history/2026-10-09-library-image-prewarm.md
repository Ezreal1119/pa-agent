# 全库图片预分析与当前 SOP 中止

用户发现首次生成图片评分等待过久，要求停止当前任务，先全量分析 Library。

## 已执行

- 通过正式后端取消任务 `2d8c66e8-8841-48e3-95bf-e63322e1f89c`，确认 `cancelled / busy:false`，阶段为 generate-sop，Library 锁已释放。
- 已生成 Excel 保留：`.data/ckd/runs/2d8c66e8-8841-48e3-95bf-e63322e1f89c/outputs/GPOS730_write_number_2026-10-09.xlsx`（14,460,687 字节）。成功视觉缓存也保留。
- 启动正式 Library 真实视觉批次 `9114d31d-7f0a-4643-a694-5e60fda71c3c`，638 个原始 PNG/JPEG、263 个唯一 Hash，3 张并行。日志 `.data/ckd/image-prewarm-2026-10-09.log`，状态 `.data/ckd/image-prewarm/<id>/state.json`。本记录只确认启动，不宣称全量成功或完成。
- 首个返回存在无效结构 `Exactly one primary subject is required.`，已记录逐图错误并继续其他图片，不写入成功组合缓存；结束后可显式恢复重试失败项。
- 本轮结束前再次核对进程仍运行：已处理6/263，成功2（新分析1、复用1）、失败4；错误为主体角色数量或结构缺少字段/非对象。真实模型确实返回了可复用结果，但结构输出不稳定，失败项未算通过，任务继续处理剩余图片。

## 实现

新增 `src/ckd/image-prewarm.ts` 和 `npm run ckd:images:prewarm`，只读扫描 product_lib/processes_lib，排除 derived/CN_derived，跨路径/语言按 SHA-256 去重。沿用 ImageAssessmentChecker 的初检、独立保守复核、版本化缓存和数值评分，未改提示词、权重、上限、校准或通用 Agent Core。并发可配置1–4，默认3；每个模型请求的5分钟超时及临时网络/限流重试沿用原适配器。

任务目录持久化参数/校准快照、来源路径及 Hash、逐图状态/结果和错误。成功项逐张原子保存；Ctrl+C 中断后显式 resume，重试未完成/失败项；cancel 为终态。Library/任务锁为跨进程互斥，取消/中断等待工作线程退出后释放。分析前后检查所有同 Hash 来源路径，外部变更报告错误，不覆盖来源。当前批次完成前 SOP/维护不能占用同一 Library。

不翻译、不维护摘要/描述、不校准参考图、不改源图片；工序操作重点的文字匹配依赖实际 SOP，仍在生成时执行，不做全库预热。未改管理员 Web 或桌面 UI，不需要重启用户应用和正式后端。

## 验证

typecheck、build、完整137项测试及diff检查通过。新增4项受控模型测试：双语去重/并发限制/SOP缓存复用/来源不变、无效输出及重启重试、暂停与互斥释放、取消/超时/外部Hash变化。测试不调用真实模型、不使用正式Library。真实视觉仅为上述正式批次，仍在运行；逐图失败保留在状态中，不能算作通过。

README 增加启动/状态/恢复/取消及 Library 锁说明；docs/core-changelog.md 增加当前模块、流程图和累积记录。仅修改 pi-patrick；没有运行 patrick-agent 的生成器、构建或测试，没有修改其代码。
