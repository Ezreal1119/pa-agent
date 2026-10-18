# 2026-10-18 Office 元数据编码兼容

目标仅ProductExpertCloud；patrick-agent/pi-patrick不修改。用户Spec EDC 070569.xlsx为48452字节的Office ZIP，5个customXml/item*.xml用UTF-16LE BOM编码，其中声明us-ascii/utf-8与字节不一致；主工作表均UTF-8可解析。预检强制UTF-8解码造成InvalidChar。按实际BOM解码后元数据XML结构校验通过。没有以跳过customXml或关闭XML/实体检查来规避。

新增office-xml.ts，预检先fatal解码，再拒绝DOCTYPE/ENTITY并验证XML，错误带部件名。UTF-32明确拒绝；不支持的其他编码不猜测。原ZIP、元数据和源文件保持原字节。写入精确匹配含尾空格的工作表名，旧trim回退保留。

验证：本机79项完整测试通过。新增tests/office-xml-encoding.test.mjs的4项测试涵盖UTF-8/UTF-16LE/BE及签名、错误字节、危险声明、畸形XML、体积限制、worker读取/写入与元数据保留。真实附件仅只读加载，FileTools在独立debug存储中按workbook与Spec EDC 工作表读取成功；测试输出C5=ENCODING TEST，15个customXml部件全部字节相同，源附件摘要c35381175f2df24032421957db2ff9f6e933c481a92a99ec311f6ef0d34ed0d2不变。debug/office-xml-encoding含验证脚本、日志、隔离inputs/outputs，全部Git忽略，未交付测试标记文件。

没有连接/修改VPS，本轮未跑真实模型，不能宣称新代码已经在VPS验收。没有改业务知识、记忆、.env或原始附件。同步方式为开发机提交推送，VPS停止服务、git pull --ff-only、build和4项定向测试后再启动；无需重装依赖。
