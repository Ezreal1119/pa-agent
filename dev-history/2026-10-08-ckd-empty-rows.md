# 删除 Library 全空 JSONL 占位行

用户要求“如果是空的就都删除”。检查 pi-patrick 当前 product_lib/processes_lib 的 JSONL，删除所有字段均为空字符串/空白/null 的占位记录，包括原来 qty 缺少 JSON 值的全空记录。没有删除非空记录、空文件或目录，没有修改归档、翻译备份或 patrick-agent。

28 个文件共删除 68 条全空记录，其中包括此前 4 个无效文件的 8 条错误行；修改文件中原有的 16 条非空记录按原始字节保留。全空文件保留为 0 字节，继续表示项目覆盖公共层，避免删除文件后意外继承公共工具资料。

修改前备份与逐文件 Hash/删除行号清单：`.data/ckd/repairs/2026-10-08T07-43-05-918Z-empty-rows/`，其中 `before/` 是原文件，`changes.json` 是清单，`validation.json` 是验证报告。

验证：调用项目的 `validateCkdLibrary()` 全量扫描 836 个 JSON/JSONL 文件，语法错误为 0；运行项目内 build-ckd-catalog-v3，以正式 Library 构建英文 PCBA Catalog，通过。仅修改业务数据及记录，没有修改运行时代码，不重复执行代码测试。
