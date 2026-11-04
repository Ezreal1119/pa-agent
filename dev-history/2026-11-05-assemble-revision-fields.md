# 2026-11-05：assemble 制订者及修订字段

## 授权与范围

用户截图指出封面制订者没有显示 Patrick，要求修复并在新建表单增加“修订原因”“修订内容”，确认仅针对 assemble 后授权实现。工作分支 `patrick/create-ckd-sop`；不修改客户模板原件、正式 Library、旧任务、缓存、模型配置或服务器。本轮没有提交或部署。

## 原因与修改

- 旧 C7 为 `IF(A7="","","Patrick")`，首行 A7 原版本未赋值，故作者被隐藏。新版 assemble 首行 C7 直接写归一化后的作者；后续修订行仍由对应版本决定是否显示作者。
- 输入增加 `revisionReason`、`revisionContent` 两个可选字符串，分别最多 1000/4000 字符；空白默认空字符串，支持内部换行。其他四类输入拒绝非空修订字段，界面切换类型时隐藏并禁用字段，提交时不带这些键。
- 桌面/Web 新建表单各增加两个多行输入；任务详情及按原信息新建保留原值。后端 Schema、任务输入校验、独立归一化脚本、直接生成和图片确认后的 generation 快照均透传，不交给模型推测或翻译。CLI 可使用 `--revision-reason` / `--revision-content`。
- 客户中英文封面首条 D7:E7、F7:H7 分别写修订原因/内容。按文字估算首行高度，从未使用的后续修订行借用高度，后续行至少 24 点，首行不超过 400 点，保持封面总高度。极长文字沿用完整文本续页和引用机制，封面/排位图/页脚计数同步；未截断存储值、未缩小字体。原始 xlsx 资产未修改。
- 桌面版本统一升至 0.1.7，保留原 Aliyun 云端配置 `http://8.133.254.83`，不修改本机版地址。旧输入和旧客户端可省略新字段；新客户端使用新字段前，阿里云后端需要更新本次代码。

## 验证

- `npm run typecheck`、`npm run build`、相关 JS/CJS 语法和 `git diff --check` 通过。
- 完整测试：`CKD_SCORER_PYTHON=/Users/patrick/ckd-sop-agent/.venv-scoring/bin/python npm test`，238 项中 236 通过、2 项 Linux 专用测试在 Mac 跳过，0 失败。
- 新增 4 项回归：双语真实状态机归一化/后端重启/封面值；选填、范围、类型及长度校验；HTTP 客户端字段持久化与重新登录读取；极长修订文字完整续页。同时增强实际 Catalog→直接生成、准备图片→裁剪确认生成两条路径的修订字段断言，旧无新字段输入仍覆盖。
- 隔离无头 Chrome 加载实际桌面 HTML/CSS/JS，仅 IPC 使用测试替身，无生产连接/模型调用：验证字段只对 assemble 显示启用、提交中去除外围空白但保留内部换行、按此信息新建恢复值、切换其他类型后字段从请求移除，页面无脚本错误。截图 `/tmp/ckd-revision-ui.png`。
- 本机合成数据生成 `/tmp/ckd-revision-cn.xlsx`、`/tmp/ckd-revision-en.xlsx`，无原版本也显示 Patrick，修订原因/内容写入正确位置，0 警告。使用独立 LibreOffice profile 和临时中文字体配置渲染 PDF，人工确认首条 Patrick、原因、两行内容及后续空白修订行、页脚均正常，未覆盖客户模板。此验证不等同于 Windows Excel 实机验证。

## 客户端与部署边界

Mac 云端 0.1.7 已构建，包内版本、阿里云地址和关键文件已与当前源码逐字节核对。Windows x64 应用已生成；NSIS 构建工具的 macOS 二进制仅支持 x86_64，本机无法运行（spawn error -86），因此改用 electron-builder 的 Windows ZIP 目标提供完整解压客户端，不安装 Rosetta 或修改系统配置。Windows ZIP 构建成功，双方包内版本均为 0.1.7、后端均为 `http://8.133.254.83`，8 个关键源码文件逐字节核对一致，无 Library/密钥/任务数据；两个 ZIP 完整性通过，Windows ZIP 包含主程序、app.asar 和运行资源，校验和保存到同目录 `CKD-SOP-Cloud-0.1.7-SHA256.txt`。

产物：`desktop/release/cloud/CKD-SOP-Cloud-0.1.7-mac-arm64.zip`、`desktop/release/cloud/CKD-SOP-Cloud-0.1.7-win-x64.zip`。Windows 必须完整解压后运行 `CKD SOP Cloud.exe`，不单独分发主 EXE。

产物保持 Git 忽略，不包含 Library、密钥、运行数据或后端。Windows 未做实机验证；本轮没有更新阿里云服务，不能将本机通过写成线上已生效。应先更新后端，再使用客户端新字段；旧完成文件不回写。
