# 长英文工序工作表名称保留编号

## 原因与调整

`fill_sop_sheet.js` 原来先把工序名称截为 31 个字符，再做工作表重名检查。`Heating platform usage instructions 1` 和 `... 2` 的末尾编号均被截掉，于是 Excel 生成报 `Duplicate sheet name`。

只在清理后的名称超过 31 字符且末尾有十进制数字编号时，为该编号（包括其前的空格）预留位置，再截断前段名称。完整工序名称仍留在生产安排表及工序正文。短名称、无编号长名称和真正相同的工序名称继续按原规则处理，不要求 AI 修改 Library，也不改数据、模板、桌面端或 API。

## 验证

使用两个实际会相撞的长英文工序生成 Excel，再回读确认工作表名称不同、均不超过 31 字符且保留 `1`/`2`，正文和安排表仍是完整名称；把第二个工序改为真正同名时仍应报重名错误。执行 `./node_modules/.bin/tsx --test --test-timeout=30000 tests/ckd-sheet-names.test.ts`、`npm run typecheck`、`npm run build`、`npm test`、`git diff --check` 和 `node --check resources/workflows/create-ckd-sop/create-ckd-sop-v3/fill_sop_sheet.js`。完整测试 191 项通过、2 项平台条件跳过、0 失败。

部署前只读检查 VPS：服务正常，11 个任务处于运行/等待状态，其中 9 个仍与当前工作流资产 Hash 一致。修改生成器文件会使这些未完成任务在下一次脚本调用时遭到资产校验拒绝。因此当时只完成本地代码和验证。随后 JPG 图片支持上线时，先在资源树外完整备份旧资产并启用精确 Hash 匹配的旧任务路由，再一并部署本修复；远端 Sheet 名定向测试通过，未修改正式 Library 或旧任务数据。
