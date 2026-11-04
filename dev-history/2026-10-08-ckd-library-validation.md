# CKD Library 语法检查

新增 POST `/api/library/validate` 以及页面“检查资料库”入口。扫描服务配置的 Library，支持 SOP 类型和中英文范围筛选，返回全部 JSON/JSONL 解析错误的路径、行、列、错误类型、扫描统计。默认全量包含归档。读取失败、无效 UTF-8 和符号链接也报告；不读取图片、Excel、隐藏文件或 node_modules。

只读、不调用模型、不生成 Catalog、不创建任务、不修复原始文件，不验证业务字段完整性。接受无 Origin 的本机 curl/Postman 请求；带 Origin 的浏览器请求继续要求同源和 UI header。非法范围/任意路径参数拒绝。

JSON.parse 是语法是否合法的唯一依据；原生错误缺少偏移时使用诊断解析器定位。JSONL 逐行继续检查，空行跳过，行号保留原文件位置。UI 通过 textContent 显示错误，可滚动查看完整列表；不改变当前 SOP 表单或任务。

验证：

- `npm run typecheck`、`npm run build`、`npm test` 通过，共 45 项测试。
- 新增 5 项测试，覆盖多文件/多行错误汇总、行列号、筛选与公共元数据、只读、UTF-8/BOM/CRLF、符号链接、无原生偏移定位、非法请求、curl/浏览器来源、Library 不存在及不调用模型/不创建任务。
- 真实 POST 全量检查：524 个文件，778 条解析记录，4 个文件共 8 处错误。
- 错误均位于 GPOS710/pcba_test/processes 下 tools_fixtures_equipment.jsonl：MCU_Download_Operation 第 1–3 行；MotherBoard_Writenumber 第 3 行；Software_environment_setup 第 1–3 行；WriteNumber_Fixture_Build 第 3 行。均为 qty 缺少 JSON 值。
- PCBA 中文筛选检查 13 个文件/记录，语法通过。
- 重启空闲本地服务后，通过浏览器点击检查，确认统计和逐条路径、行列号可见。截图在 `.data/ckd/ui-library-validation.jpg`。
- 本轮仅修改 pi-patrick；未执行 patrick-agent 的构建、生成器、迁移或测试。
- 与迁移基线对照，旧仓库 CKD Library/工作流相关文件 Hash 一致。全仓库另有产品知识 skill 的变化，不属于本轮操作；未尝试恢复或覆盖。

README 新增 API、curl 示例、响应和恢复说明；设计文档新增扫描边界及来源校验约定。未增加依赖。
