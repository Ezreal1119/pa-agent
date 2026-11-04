# 2026-10-10：图片格式失败的最小 0 分兜底

用户选择：模型结果无法通过格式校验时给0分、提醒并让业务继续；不放宽唯一primary约束，不重构多面板评分。以pi-patrick现有实现为准，未修改patrick-agent。

## 行为

- `ImageAssessmentChecker.check()`仍为严格入口，已有初检/复核与最多两次格式补试保持不变。持续校验失败改用专门错误类型；模型适配器的空内容/截断使用独立错误类型，不改变通用Agent行为。
- 新增 `checkWithFallback()`：业务入口捕获上述错误，独立记录 `score:0, reminder:true, analysisSucceeded:false, retryable:true` 及原错误。不构造主体、边界框或七项观察。文件位于 `.data/ckd/image-quality-failures/seven-dimensions-v4/<SHA-256>.json`，与成功观察分离。
- 同Hash失败直接复用，避免工作流重复等待；有效成功缓存始终优先。`POST /api/images/quality?retry=true`、严格预分析恢复可以显式重试；恢复成功后自动使用有效观察。参考图校准及样例复核仍用严格入口，失败记录不进入校准。
- SOP继续完成Excel与评分报告；按不同图片将失败0分计入新报告平均分，每个采用路径均强制提醒。工序业务评分不变；有效观察但低置信度仍为原未评分状态，不改成0分。旧任务不追溯更新。
- 管理员总同步写逐项0分与失败标记，保留部分失败状态并继续摘要阶段。全库预分析严格统计真实成功，不把兜底计成成功。
- 单图测试HTTP200表示处理完成，失败返回 `{result:null,fallback,error}`。Web与Electron分别展示0分、分析失败、需人工复核及原错误；没有虚构七项分数。
- 无效输入、取消、超时、配置/网络/提供方异常、来源变化仍保留原错误处理，不泛化为0分。

没有修改模型、提示词、校验Schema、公式/权重/阈值/上限、分析/数值版本及依赖。没有新增API路径，只在现有单图接口增加可选retry查询参数。

## 既有正式数据

原预分析批次 `9114d31d-7f0a-4643-a694-5e60fda71c3c`：253张有效成功，10张协议失败，263唯一图片（638文件），历史终态仍为partial_failed。本轮未重跑模型，也未把原任务改为完成。

对10项错误逐一确认是三次格式尝试后的枚举/对象结构/唯一primary失败，取得Library锁后复核所有对应路径的来源Hash，再登记独立失败记录。以会抛错的模型替身确认10项后续调用均返回cached=true、score=0、reminder=true且模型调用0次。这仅验证业务兜底，不声称这10张得到有效识别。

保护快照及登记收据（Git忽略）：

- `.data/ckd/failure-fallback-rollout-2026-10-10/before.json`
- `accepted-failures.json`：来源批次Hash、10项路径/Hash及兜底记录。
- `verification.json`：正式HTTP检查及既有文件Hash核对。

登记前后及正式HTTP检查后，972个既有任务/成功观察缓存JSON逐文件Hash相同，原预分析state.json的Hash相同。Library只读取，未启动翻译、摘要或全量维护，未修改图片和参考标签。

## 验证与运行

- `npm test`：149/149通过；新增6项兜底测试及1项总同步测试，调整预分析测试以区分协议失败和无效图片。
- 临时Library受控模型：验证格式重试、失败复用、显式恢复优先成功、非协议错误原行为、去重平均分、低置信度未评分、实际Excel生成/旧产物字节保持、HTTP响应与显式重试、摘要阶段继续。
- `npm run typecheck`、`npm run build`、两个前端JS语法与`git diff --check`通过。
- 真实模型本轮新增调用0次。正式4317/4318分别测试：既有失败图HTTP200/0分/强警告/cached=true；既有成功图有效缓存复用。未请求retry=true；未全量重跑。登录/status/logout均通过，不输出令牌。
- 无运行SOP/维护任务后更新4317/4318后端；内存会话失效，需要重新登录。
- `npm run desktop:pack:mac`通过，更新 `desktop/release/CKD-SOP-0.1.0-mac-arm64.zip` 及 `desktop/release/mac-arm64/CKD SOP.app`（约122MB，无签名）。没有操作用户桌面，由用户重新打开新版应用测试；Windows未实机验证。

结果应表述为“253张有效分析 + 10张0分兜底并警告”，不能写“263张分析成功”。
