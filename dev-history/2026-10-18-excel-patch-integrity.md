# 2026-10-18 Excel 空单元格写入完整性

只读调查VPS真实session发现：原33行模板（PTG_TOR_69_017_Requirements.xlsx）所有行均有r属性，F5/F7为带样式自闭合空单元格。旧正则的贪婪开标签匹配优先走成对分支，跨越行界直到下个</c>，删除了行关闭/开启等内容；多格输出只剩5行，单格输出少第8行。原件SHA-256与manifest相同。模型归因“缺行号”错误。

实现限定ProductExpertCloud：excelTemplateOoxml使用安全元素扫描进行定位/插入；新增excelTemplateValidation独立检查值/未改区域/样式/行/布局，最终ZIP再验一次。验证错误在FileStore.publish之前返回，无文件登记。没有修改patrick-agent源项目或VPS；不自动清理旧输出，不改变知识/记忆/session及其30天规则。

本机75/75完整测试通过。新增tests/excel-template-patch.test.mjs的8项回归，包含真实worker拒绝结构不确定的文件、publish回调未触发、manifest无outputs、原件字节不变、work清理。人工破坏输出测试复现旧贪婪跨行替换并验证拦截。真实附件及两次原始参数仅作为Git忽略的本地debug副本，重放37格及1格操作后均33行；通过ExcelJS重新打开检查，输出不涉及业务事实正确性审核。日志.data/debug/excel-patch-fix/{full-tests.log,regression.log,replay.log}，生成结果replay-1.xlsx/replay-2.xlsx。此次不调用真实模型，无新增VPS验收声明。

部署指南同步补齐ripgrep/fd-find，纠正前序依赖清单遗漏。同步时Mac审查并提交推送，VPS停服务、pull --ff-only、构建、运行新回归再启动；无需pip/npm依赖更新或.env调整。root运行的现有systemd覆盖配置不变。
