# 生成文件交付

目标 `/Users/patrickxu/ProductExpertCloud`。新增 src/file-tools/outputs.ts，实际文件成功发布后直接通过 Runtime 持有的可写 SessionManager 登记 generated-file-v1 JSONL 元数据，不依赖模型生成 fileId/路径，也不向模型暴露登记工具。记录用户消息 ID、run、tool call 和 FileStore 后端生成的元数据。

Web output 事件及时发送文件给当前回答；消息视图 outputs/outputNotice 用于刷新/重启恢复、多文件和失败/停止占位下载。原文件汇总和受认证下载接口继续使用，旧工具结果的结构化 file 可恢复历史卡片；模型正文不参与登记。当前实现的写文件工具是 excel_patch_template，卡片类型按实际文件扩展名显示。

验证：全套 66/66，之后 13 项相关用例通过。测试使用真实 SDK、真实文件 worker 和本地模拟主模型，验证多输出、JSONL 关联、无正文路径、虚构文件不显示、错误/停止后下载、关闭工具及旧记录恢复；没有再次调用真实模型或更改解析 worker。

浏览器 4322 隔离服务以一次性 output-test 账号运行，生成“报价单_修改版.xlsx”，回答仅“已将数量改为 77，原文件保持不变。”，卡片正常出现并下载。下载文件 `/Users/patrickxu/Downloads/报价单_修改版.xlsx` 用 ExcelJS 打开验证 Data!B2=77，原 fixture Data!B2=42。截图 `.data/debug/output-delivery-ui/output-card.png`，测试目录和日志全部 Git 忽略。未删除用户实际会话或修改业务记忆/知识/.env。最终 4321 重启加载此功能。
