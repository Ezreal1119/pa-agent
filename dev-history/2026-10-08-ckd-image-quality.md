# 2026-10-08：SOP 图片构图检查与测试 API

## 范围与实现

仅修改 `pi-patrick/create-ckd-sop`。旧 `patrick-agent` 不参与执行、构建或写入。没有新增依赖、Agent tools、LangGraph、UI 框架、Electron 或自动裁剪。

- `src/ckd/image-quality.ts`：图片头/尺寸检查、视觉 JSON 协议、严格坐标校验、类型阈值与评分、Hash 缓存、跨进程互斥、超时/取消、SOP 图片检查与报告。
- `service.ts`：生成脚本保存凭据后、最终节点提交前检查图片。复用 `fill_sop_sheet.js` 导出的照片选择逻辑；Factory Test 仅第一张，Assembly 包含前站检查图。模板图片不参与。
- `library-model.ts`：仅新增可选 `imageMimeType`，旧调用默认 PNG，不改变通用 Core 或摘要维护语义。
- `ui-server.ts`：POST `/api/images/quality`；PNG/JPEG 二进制，10 MiB、4000 万像素、单边 20000 像素限制。不接受任意磁盘路径。无 Origin 本机请求可用，浏览器保留同源及 header 限制。
- CLI/UI：输出独立图片总体分、覆盖数量、逐图状态；JSON 报告注册为下载产物，下载类型区分 JSON 与 Excel。既有工序评分不修改。

模型仅返回类型、主体、边界框、置信度与原因，分数由程序计算。主体占比指整个有效内容边界框面积占比，不是像素分割；框内背景和拼图内部空隙不按可裁剪外留白处理。阈值为 object 0.65、screenshot 0.8、diagram 0.65、scene 0.5，得分为 round(100×min(1,ratio/target))。置信度低于 0.7 / unknown 不评分；错误不作为通过。

报告 `status` 为 completed / partial / no_images。总体得分只对有评分的不同图片取平均，覆盖数与失败/待确认数同时输出。建议区域保留 3% 外边距，绝不自动执行裁剪。

## 缓存、恢复与兼容

缓存保存于 `.data/ckd/image-quality/<rule-version>/<sha256>.json`，与 Library 图片描述缓存独立。同字节图片跨语言/路径/任务复用；版本或字节变化重新识别，模型配置变化不会自动失效旧缓存。失败/无效结果/取消/超时不缓存。首次同 Hash 并发返回 409，后续重试复用成功缓存。缓存读取重新校验观察值并重新计算分数。

生成脚本原始凭据继续只保存生成器产物。检查中断后恢复复用凭据里的工作簿，成功图片复用缓存，生成器不重复执行。图片检查失败仍交付 Excel 并输出 partial，任务取消会中断检查。已完成旧任务不追溯执行图片检查。Library 原始图片和业务资料不写入。

## 验证

- `npm run typecheck`、`npm run build`。
- `npm test`：77 项通过，新增 8 项涵盖分数、PNG/JPEG、Hash 变化/缓存恢复、无效模型输出、配置缺失、互斥、取消/超时、五类照片选择规则、真实 TypeScript 工作流生成与重启后凭据恢复、二进制 HTTP 请求及来源限制。
- `node --check resources/ckd-ui/app.js`、`git diff --check`。
- 工作流与异常测试使用临时 Library、注入模型；没有全量调用正式 Library 图片检查。

真实视觉模型为当前独立配置的 `qwen3.8-flash`。联调证据位于 `.data/ckd/image-quality-smoke/`：

- `first.json` / `repeat.json`：完整 ANT Config 软件截图，V1 返回 100 分；重复请求 cached=true，内容 Hash/时间不变。
- `tool.json`：含连线、标注的多图拼图，V1 返回 diagram、主体框占比 93%、100 分；不将必要拼图间隙误作外边距。
- `fixture.json`：设备照片 V1 的初次结果，仅用于回溯校准，不作为分类准确性结论。
- `user-image.json`：用户提供的 Downloads 图片，V1 识别框占比 46.5%，但误归 scene 导致 93 分，边界也靠近外壳底部。

用户样例暴露问题后，将规则升级为 `subject-framing-v2`：单张设备/零件/连接组合照片，即使位于桌面上、有数字或红框也优先归 object；scene 只适用于必须保留环境空间关系的宽幅工位场景。提示明确包含完整外壳、安装脚/耳、连线及标注，要求逐边复核，存疑时扩宽边界并降低置信度。V1 缓存保留作审计，但不会被 V2 复用。用户图片 V2 复测结果在下方追加。

## 本机服务

原 4317 进程仍执行此前用户授权的正式 Library 摘要维护，未中断。新代码在 4318 启动，测试 API 使用 `http://127.0.0.1:4318/api/images/quality`。正式库维护与 SOP 共用互斥，因此维护完成前新 SOP 运行可能返回 409；上传单图的检查接口不读写 Library，可独立测试。

## 用户图片 V2 实测结果

输入 `/Users/patrickxu/Downloads/WXWorkCapture_1791454047200.png`（733×496），SHA-256 `3bf6ea9327fcf2d881968df8c9bc24112f8b716f5969936fb45c34bea5f451e1`，原图未修改。

`user-image-v2.json` 返回：object、confidence 0.95、边界框 left=0.06/top=0.25/right=1/bottom=0.82，主体框面积占比 53.58%，框外区域 46.42%；四边外边距左 6%、上 25%、右 0%、下 18%。阈值 65%，得分 **82/100**，状态 excessive_whitespace。建议区域 left=0.03/top=0.22/right=1/bottom=0.85，约对应原图 x=22..733、y=109..422；只是建议，未执行裁剪。视觉复核可见底部安装耳、排线、USB 连接和红色标注均保留。

`user-image-v2-repeat.json` 返回 cached=true，分析时间、Hash、分数均一致。本轮 V2 测试使用真实 qwen3.8-flash，仅一张用户图片；V1 历史样例仅用于校准，不冒充 V2 全量准确率。阈值和场景分类仍需更多样例验证。

另在独立临时 Library 中放入该图片，复用真实 V2 缓存，完整执行 Factory Test SOP 生成（无额外视觉调用），结果保存于 `.data/ckd/image-quality-smoke/ui/`。浏览器人工核对了最终页面：原工序评分 90/100、独立图片评分 82/100、主体框占比 53.6%、留白偏多建议，以及 Excel/JSON 两个下载入口。该测试不是正式 Library 业务任务，未绕过正式库维护锁。
