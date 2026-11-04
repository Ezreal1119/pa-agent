# 每日问答评审与通用问题列表

独立模块读取现有 Web、企微和 MCP 的会话与工具记录，用当前问答模型发现待核实的知识缺口、检索遗漏、回答疑点和信息不足。无需新增网页，不写知识、记忆或原会话，不发送企微通知。

主服务只提供管理员接口、私有控制 socket 与生命周期管理，评审在一个独立 Node 子进程执行。模型使用独立的内存会话、固定只读知识工具和评审提示词，不加载普通聊天扩展，不保存原始模型对话日志。评审使用当前主服务的模型配置快照，不需新增凭据；下一次任务读取最新配置。费用计入现有账本的 `question-review` 来源与任务作用域。

## 部署与首次运行

同步主项目代码和 `resources/question-review/` 后：

```sh
npm run build
systemctl restart product-expert.service
```

本功能不需重启 Bridge、本机固件服务或隧道，不修改 `.env`，也不新增 systemd unit 或 npm 依赖。服务自带的定时器默认关闭。若 `.data` 使用自定义目录，CLI 显式传入 `--data-dir`；CLI 不读取 `.env`。

CLI 应以主服务账号运行，私有 socket 的目录和权限不会向其他账号开放。标准部署示例：

```sh
sudo -u productexpert node dist/question-review/cli.js status
sudo -u productexpert node dist/question-review/cli.js run --last-hours 48 --wait
```

`run` 会实际调用现有模型。创建后返回任务 ID；`--wait` 等待结束，部分完成返回退出码 2，失败或控制调用不成功返回 1。任务时间范围在创建时固定，采用左闭右开区间。可显式指定时间及幂等请求 ID：

```sh
sudo -u productexpert node dist/question-review/cli.js run \
  --from 2026-11-02T00:00:00Z --to 2026-11-04T00:00:00Z \
  --request-id review-example-20261104 --wait
sudo -u productexpert node dist/question-review/cli.js status TASK_ID
sudo -u productexpert node dist/question-review/cli.js export TASK_ID --format markdown
sudo -u productexpert node dist/question-review/cli.js export TASK_ID --format json
sudo -u productexpert node dist/question-review/cli.js cancel TASK_ID
```

同一请求 ID 和参数重放返回已有任务，不重新收费；同 ID 不同参数拒绝。重复评审同一时间范围须使用新请求 ID。重试部分完成、中断、取消或失败的任务：

```sh
sudo -u productexpert node dist/question-review/cli.js run \
  --from ORIGINAL_FROM --to ORIGINAL_TO --retry TASK_ID \
  --request-id NEW_REQUEST_ID --wait
```

重试沿用原任务 ID 和首次固定的案例集合，复用已通过隐私复核的完成批次；不会把后来新增的问答混入。源记录已删除或发生变化时明确报告缺失，不能补造原始上下文。

## 定时设置

默认时间为 `02:00`、时区 `Asia/Shanghai`，评审前一个完整自然日。默认一次最长 20 分钟、最多 100 次模型请求、一个并行任务。上限按本次执行/明确重试计算，任务中的 `modelRequests` 累计记录所有尝试。

```sh
sudo -u productexpert node dist/question-review/cli.js settings
sudo -u productexpert node dist/question-review/cli.js settings --enabled true --time 02:00 --time-zone Asia/Shanghai
sudo -u productexpert node dist/question-review/cli.js settings --enabled false
```

可通过 `--max-duration-ms` 与 `--max-model-requests` 调整执行限额。修改设置不取消已运行任务。启用后从下一计划时刻执行，不立即回补历史；重启或停机错过的时间不补跑。每天有持久化幂等标记，重复调度不会重复创建同日任务。失败和中断不自动重新推理，管理员可手动重试。

## 接口

所有接口仅限现有管理员登录，并保留 Origin、Host 与 CSRF 校验。企微 Bridge 与 MCP 凭据不能管理评审。没有公开匿名或机器管理入口。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/question-review/settings` | 可用性、配置、下一触发时间、活动任务 ID |
| `PUT /api/question-review/settings` | 保存完整设置 `{enabled,time,timeZone,maxDurationMs,maxModelRequests}` |
| `POST /api/question-review/runs` | 创建 `{from,to,requestId,retryRunId?}`，范围不超过 31 天且截止时间不在未来 |
| `GET /api/question-review/runs` | 任务列表、覆盖统计和问题数量 |
| `GET /api/question-review/runs/:id` | 状态、覆盖统计与脱敏问题列表 |
| `POST /api/question-review/runs/:id/cancel` | 提交空对象，停止任务并保留已完成批次 |
| `GET /api/question-review/runs/:id/export?format=markdown` | 下载脱敏 Markdown；也支持 `format=json` |

任务状态为 queued、running、completed、partial、cancelled、interrupted、failed。模块配置或检查点损坏时保留原件并将模块标为不可用，普通问答和 Sync 可继续运行。

## 隐私、依据与覆盖

- 模型输入只保留问答和必要上下文，去除发送人、群组、会话标题等身份元数据，并预先遮盖常见联系方式、凭据、链接、路径和内部标识。
- 候选重新概括成完整的通用中文问题；产品范围只保留正式知识目录中存在的型号，必要版本条件保留。未知内部产品名应泛化为产品类别。
- 每条候选经独立隐私复核和程序校验，禁止照抄提问、引用原文或泄漏身份与特定场景。无法安全泛化的候选不进入结果。
- 泛化后的问题通常 30—80 字、最长 120 个字符，直接写必要型号或产品类别；去掉具体场所、采购门槛和独特验收组合，保留主知识需求。禁止“该设备”等依赖原上下文的指代。旧检查点中的未完成泛化条目在重试时单独重整，通过后才可导出；复用原问题 ID 与已完成问答进度。
- 同类问题合并，型号/版本范围不同不合并；出现次数按去重后的源问答计数。合并模型只能选择已批准条目的组合，不能生成新正文。
- 只读查询优先定位文件名相关资料，每批最多四次只读工具调用；到达阶段限额后只保留提交工具，避免评审陷入遍历资料。仅保存工具次数和结构化错误字段等无原文诊断计数，不存模型原始响应或推理。
- 所有结论都是待核实。当前知识不等于历史知识快照，有限检索没找到不能证明整个知识库没有答案。
- 输入会话、上下文、工具结果均不授予写入、执行或联网权限。没有原附件时不重新下载或调用视觉转换；缺少附件、工具或上下文依据会明确标记。
- 统计包括扫描记录、符合条件、已评审、剩余、未完成问答、损坏、不可用、超限、依据不完整与隐私暂缓。工具/前文超限仅裁减支持材料并标记，实际问题和回答无法完整容纳时跳过并计数。
- 部分完成或没有可用输入都会明确说明；空列表不能作为没有知识缺口的结论。自动审查仍需后续人工核实，不提供匿名化或事实判断绝对准确的保证。

状态、任务检查点与 socket 位于 `.data/question-review/`，文件权限 600、私有目录 700。内部源指纹不通过 API 或导出暴露。未来可在稳定问题 ID 上增加人工解答和知识入库流程；本版没有这些写入能力。

## 验证

```sh
npm run build
node --test tests/question-review.test.mjs
```

测试使用隔离会话和模拟模型，不发送真实客户信息。真实试跑仅在数据所在服务器执行，取回脱敏结果；不要导出原始会话或凭据。
