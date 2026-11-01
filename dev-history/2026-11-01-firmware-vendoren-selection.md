# 固件 VendorEN 后缀过滤与多候选选择

## 行为

- AI 继续仅提取型号、六位日期和两位 index，原查询目录不变。
- 本机结构化查询仅计入以 `_uFWsign_VendorEN.zip` 结尾的文件，忽略大小写；先过滤后统计、截断和读取元信息。普通 rel、VendorXX 及其他尾缀均不匹配。
- 唯一匹配直接进入确认；多个匹配保留流程，回复 `2` 或 `选择 2` 后进入确认。选择本身不启动传输，仍须原用户在原会话发送本次确认码。
- 候选列表只显示编号及文件名，确认只显示文件名、大小与操作提示。查找、进度、失败等机器人回复不展示来源协议、源文件路径或存储后端名。
- 选包阶段占用全局名额，5 分钟超时，可取消，重启可恢复。非法序号不改变候选，不重新调用 AI。
- 沿用最多展示 12 项的上限；超过时明确显示总数及展示数量，仅能选择列出的项。

## 升级

本机查询响应标记改为 `model_date_index_vendoren_and`，Agent 同时校验协议与文件后缀，拒绝旧版未过滤的结果。未确认流程版本升为 3，旧版本提示重新发起；已提交或运行的任务保留原身份和跟踪状态。

本机 `local-download-service/firmware.py`、测试和 README 已更新，整个目录继续被 Git/Docker 忽略。先用原 stop/start 命令重启本机服务，再同步主项目、构建并重启 Agent。Bridge 和隧道无需修改，无新增配置。未访问 VPS、未修改实际环境变量、未发送真实机器人消息。

## 验证

- `npm run build` 通过。
- `node --test tests/firmware*.test.mjs tests/wecom-commands.test.mjs`：36 项通过，包括群聊 Web API → Bridge → 序号选择 → 确认 → 取消、身份隔离、重启恢复及简洁文案校验。
- 本机测试 `test_service.py -k structured_query`：6 项通过，使用隔离的本机测试服务器和临时文件，覆盖真实查询、后缀过滤先于计数/截断、完整性与条件校验。
- 日志：`.data/firmware-vendoren-tests.log`、`local-download-service/data/test-vendoren.log`（均不提交）。
