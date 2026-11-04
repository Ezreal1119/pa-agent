# CKD 分支提交检查点

按用户要求，将当前已实现的 Core 扩展、独立 CKD V3、CLI、本地 UI、Library 语法 API、测试与迁入资源提交到 `create-ckd-sop`。基线仍为 main 的 `170fa45c2bf00a00c3a9f904b6ebfc49b65754af`，没有合并产品分支或改变 main。

建立 `docs/core-changelog.md` 作为持续累积记录，包含：

- 固定基线与维护方式。
- 通用 Core 的两个文件改动、可选会话配置及兼容性。
- CKD 模块、协议工具、运行入口、HTTP API 和配置。
- 迁移、UI、语法检查、一次性翻译、空行清理的历次变化与验证。
- 尚未实现的图片主体占比/留白检测、缓存及 Electron/Windows 验证边界。

新增仓库 `AGENTS.md` 要求后续同步维护该文档，README 增加入口。保持 Library/会话/凭证/备份 Git 忽略，仅提交代码、模板、初始来源清单和文档。本机翻译后的 Library 不包含在代码提交内。

本次重新执行：

```bash
npm run typecheck
npm run build
npm test
node --check resources/ckd-ui/app.js
git diff --check
```

类型检查、构建、全部 45 项测试及前端 JavaScript 语法检查通过。测试使用临时业务 fixtures，未重新调用真实模型；此前真实模型联调单独记录在迁移记录中。只操作 pi-patrick，没有运行 patrick-agent 的生成器/构建/测试。提交前检查 `.env` 和 `.data` 均被忽略。
