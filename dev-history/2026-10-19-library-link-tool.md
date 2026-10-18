# get_file_link_from_library

落盘 /Users/patrickxu/ProductExpertCloud。

- 新增 src/tools/library-link.ts，固定 POST 指定 API，单 prompt，返回原 JSON（包含链接）。
- Runtime 将实际出站 prompt 绑定当前 session 原始用户消息，排除模型改写/额外知识与历史；Web 非空正文保留空白和换行。默认6个工具，全开文件处理时12个，不增加开关或环境变量。
- 上游失败、取消、60秒超时、256KiB有界返回，不跟随重定向、不自动下载或编造URL。
- 真实接口用用户示例 HTTP200，结果 .data/debug/library-link/api-sample.json；5项专项模拟测试通过，含并行隔离/重启/Web和企微Core复用/实际原文与工具调用追踪。无真实Agent模型验收。
- 未修改实际.env、业务数据、参考项目或VPS，未提交/推送；完整回归结果见core-changelog。
