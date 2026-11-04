# CKD SOP 用户桌面端首版

日期：2026-10-09。分支：`create-ckd-sop`，基线 main `170fa45`。

## 实现

- `desktop/` 是独立 Electron 包，Electron 44.7.0 / electron-builder 26.15.3，独立 package-lock。使用熟悉的 HTML/CSS/JavaScript，不引入 UI 框架。
- 用户界面：登录、基本信息、Factory Test 输入、五阶段 indicator、来源选项/顺序/澄清、继续/取消、最近任务、复用信息、工序与图片评分/扣分/建议、Excel及JSON评分报告保存与打开。没有管理员设置/维护/校准入口，现有 Web 静态文件未因本次桌面功能改写。
- 客户端固定连接 `desktop/config.json` 的 `http://127.0.0.1:4317`；后端单独运行，界面不提供地址修改。渲染器只调用有限 preload 方法，网络和令牌在主进程；受限本地 ckd 协议、CSP、上下文隔离与沙箱，拒绝导航、新窗口、权限和 webview。
- 后端新增 `/api/client/login|logout|status|runs`、`runs/:id`、`runs/:id/answer|resume|cancel`、`runs/:id/artifacts/:index`。凭据由后端固定校验111/222；令牌随机32字节，12小时，重启丢弃。密码不保存。除login外校验Bearer；拒绝浏览器Origin，不放宽管理员/本机边界。
- 客户端通过命名空间复用原服务、后台任务调度、结果格式及产物校验，不另建Agent Runtime。归属存在`.data/ckd/client-runs/<runId>.json`，只列出/操作该账号通过客户端创建的任务；管理员任务不导入。当前是共享临时账号，不是完整多用户/正式认证系统。
- 原生保存对话框选位置，按runId/index重新验证产物而不信任服务返回URL。流式下载到同目录partial，检查MIME、长度、ZIP签名或JSON语法后替换；失败清理临时文件、保留旧目标。打开/显示目录只接受当前应用会话内登记句柄，检查实际文件及真实路径。取消保存不报错。
- 约1.5秒轮询；断线提示重试，登录过期返回登录页。关闭/退出不取消后端任务，重新登录后从服务端恢复列表。仅最近任务ID保存在renderer localStorage，密码/令牌不进入持久化。

## 交付与构建

根命令`desktop:install/start/pack:mac/pack:win`。实际生成：

- `desktop/release/mac-arm64/CKD SOP.app`
- `desktop/release/CKD-SOP-0.1.0-mac-arm64.zip`，约122MB。

包使用默认Electron图标，未签名/公证。Windows提供x64 NSIS配置，未生成Windows包、未做Windows实机验证；Windows主机可按README命令构建。服务器部署、地址迁移、正式账号、自动更新留待后续。`desktop/release`及`node_modules`排除Git。

检查app.asar只有main/preload/backend/saved-files/config/package及ui三文件，没有Library、旧项目、Agent依赖或密钥。

## 验证与交接

`npm run typecheck`、`npm run build`、`npm test`通过，共133项。新增4项后端测试覆盖正确/错误登录、12小时过期/退出/重启、Origin限制、任务归属/管理员隔离、澄清持久化和重复回答、取消、受保护Excel/报告下载与外部路径篡改；新增3项桌面Node测试覆盖令牌不暴露renderer、固定路径/无Origin、失效清理、下载MIME/格式与失败清理、已保存文件句柄/符号链接保护。既有管理员及业务测试继续通过。桌面JS语法与diff检查通过。

Mac打包应用已实际启动，通过原生AX观察到登录和填写界面。原计划使用`.data/ckd/desktop-smoke-2026-10-09/`的隔离Library与可控模型检查完整界面；用户表示自行测试后，停止自动界面操作。**未完成自动原生保存/打开及完整桌面生成链路验证**，由用户继续测试；HTTP测试已真实运行脚本生成Excel与报告，但不是新增真实LLM联调。

用户在隔离后端尚未切回时输入GPOS730，收到`Unexpected model stage in smoke`。临时Library仅有TARGET，可控Agent只覆盖工序阶段，目标项目未命中后到达未覆盖模型阶段；这是测试接入时机问题。已停止该临时服务，4317/4318恢复正式Library与原模型配置，登录200、libraryReady=true确认通过，正式客户端任务初始0条。临时失败任务留在隔离目录，不迁入正式任务列表；用户须重新登录/新建任务。

本轮不主动生成正式SOP、不运行全量Library维护。没有修改patrick-agent或运行其构建/生成器/测试。代码未提交或推送。累计架构与接口记录同步更新`docs/core-changelog.md`。
