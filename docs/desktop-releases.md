# 桌面端云端版与重新打包

## 初版 Mac 云端测试包（历史）

- 应用：`desktop/release/cloud/mac-arm64/CKD SOP Cloud.app`
- ZIP：`desktop/release/cloud/CKD-SOP-Cloud-0.1.0-mac-arm64.zip`，约122MiB。
- 后端：`http://8.133.254.83`，账号111、密码222；后端单独运行。
- 没有打入Library、模型密钥、Agent Runtime或用户设置入口。

独立名称、appId和package name使云端版本与原本机版分别使用自己的应用数据及单实例锁；输出在release/cloud，不覆盖release中的本机包。云端窗口标题为CKD SOP Cloud。首次使用需要登录，不迁移本机登录状态。

本机开发继续读取 `desktop/config.json` 的127.0.0.1:4317。云端打包使用 `desktop/electron-builder.cloud.cjs`，将后端地址写入包内package.json的ckdBackendUrl，主进程优先读取它；地址/令牌不交给renderer。云端包中的config.json仍是开发默认值，但被打包元数据覆盖。

## 哪些更新影响云端

| 修改 | 操作 | 已安装客户端 |
| --- | --- | --- |
| desktop界面、主进程、preload | 重新打包并分发客户端 | 不会自动变更，需要安装/替换新版 |
| src/ckd业务、API、评分、工作流 | 上传后端代码、检查并重启服务器服务 | API兼容时通常不用重新打包 |
| 同时修改API契约和客户端 | 分别部署后端、重新打包客户端，确保版本兼容 | 需要配套升级 |
| 云端地址 | 改cloud构建配置，重新打包 | 老包继续使用旧地址 |
| Library、密钥、任务数据 | 在服务器维护或调用管理员接口 | 不需要重新打包 |

rsync全项目代码时，desktop源文件可以一起上传服务器，但不会替换用户电脑上已经安装的应用，也不会自动触发打包。桌面应用不包含后端；服务器无需运行Electron。当前没有自动更新、远程下载界面或自动发布机制。

## Mac ARM64 打包

在项目根目录执行，首次或desktop依赖/锁文件变化时安装：

```bash
npm run desktop:install
```

正式发新版时可递增**desktop**版本（例如0.1.0→0.1.1，同时更新desktop锁文件，不自动Git提交或打标签）：

```bash
npm --prefix desktop version patch --no-git-tag-version
```

打云端版：

```bash
npm run desktop:pack:mac:cloud
```

输出 `desktop/release/cloud/CKD-SOP-Cloud-<版本>-mac-arm64.zip`。解压并替换旧云端.app；先退出旧应用。当前为Apple Silicon版，不宣称支持Intel Mac。包未签名/公证；本机测试不代表签名分发验证。

本机版原命令继续可用：`npm run desktop:pack:mac`，输出在desktop/release，连接config.json配置的后端。

## Windows x64 打包

空白Windows电脑可使用独立源码包，例如初版 `desktop/release/cloud/CKD-SOP-Cloud-Windows-Source-0.1.0-r2.zip`。它只包含desktop源码、配置、锁文件和说明，不含后端、密钥、Library或Mac依赖。解压进入内层 `ckd-sop-desktop`（有package.json），安装Node.js24LTS x64后执行 `npm.cmd ci` 和 `npm.cmd run pack:win:cloud`，产物位于该目录的 `release/cloud/`。这是独立desktop包，命令与下面从整个项目根目录执行的命令不同；npm.cmd可避免PowerShell对npm.ps1的执行策略限制。

Electron44.7按需下载二进制，npm ci成功并不代表electron/dist存在。r2添加prepack步骤显式执行Electron自带install.js；仅本平台/架构/版本的完整运行包可复用，否则构建器回退为正常下载。旧源码包如报electronDist不存在，无需重装全部依赖，在同目录先执行 `node .\node_modules\electron\install.js`，成功后再运行打包命令。下载出错应先处理该条错误，不继续打包。

在Windows x64机器或Windows CI中安装Node.js（>=22.19.0）、复制/检出源码，然后在项目根目录执行：

```powershell
npm run desktop:install
npm run desktop:pack:win:cloud
```

输出 `desktop/release/cloud/CKD-SOP-Cloud-<版本>-win-x64.exe`，为NSIS安装包。分发新版.exe后由用户安装升级；不要把Mac安装的node_modules复制过去。版本号应与Mac发布版本一致，不要分别再递增一次。

云端profile复用npm安装的本平台Electron运行包，以上命令按本机原生平台构建；不将其作为在Mac直接交叉构建Windows的命令。Windows构建和实机验证本次未执行；无需把Library或模型密钥复制到Windows。

## 当前验证

Mac ARM64构建完成；检查asar只含界面/主进程等客户端文件，云端地址正确、原本机包/配置仍指向localhost。首次默认下载Electron遇到TLS连接中断，之后校验既有缓存ZIP的SHA-256，恢复desktop/node_modules内Electron44.7.0运行包，云端profile复用它，构建成功。

包内Electron44.7.0与BackendClient实际访问公网：登录111、Library ready、客户端任务2个、退出正常。应用已打开供用户测试，没有自动操作生成流程或触发正式Library维护。桌面3项传输/下载/路径保护测试、typecheck/build及语法/diff检查通过；完整GUI生成/保存由用户继续测试。


## 0.1.2：大文件下载修复（2026-10-12）

先部署新版后端，再安装新客户端：后端在原 `/api/client/runs/:id/artifacts/:index` 上新增 `HEAD` 文件元信息读取（与GET同鉴权及路径限制）。原GET和旧客户端继续可用；旧后端搭配新客户端会明确要求先更新服务。无需改Nginx/端口/证书，也无需重新生成旧Excel、维护Library或校准评分。

客户端下载不再重复读取完整任务/评分JSON，持续传输可超过两分钟；普通请求60秒，下载60秒无数据中断，另设30分钟总时限。结果卡片显示下载MB/百分比及校验阶段；中断保护现有文件并删除partial。注销/关闭应用取消下载，不取消后端生成任务。未增加自动更新或断点续传。

本轮桌面版本已升为0.1.2，不要再执行version patch才使用本轮包。Mac云端ZIP为 `desktop/release/cloud/CKD-SOP-Cloud-0.1.2-mac-arm64.zip`；Windows源码ZIP为 `desktop/release/cloud/CKD-SOP-Cloud-Windows-Source-0.1.2.zip`。解压后在有package.json的ckd-sop-desktop目录运行 `npm.cmd ci`、`npm.cmd run pack:win:cloud`，安装 `release/cloud/CKD-SOP-Cloud-0.1.2-win-x64.exe`。Windows需要用户实际验证：打开原约65MiB的历史SOP，保存到新路径，观察进度，完成后打开Excel；不需要再次调用模型。

## 0.1.3：生成前图片确认与裁剪（2026-10-14）

本版本新增第 5 步“图片评分与确认”：桌面端可逐图预览、拖动四角/边缘裁剪、恢复原图，再点“生成 SOP”。灰色区域会被舍弃。Excel 在点击生成后才创建；裁剪图只存当前任务，原 Library 不变。原图评分在确认页查看，裁剪后不重新评分；完成页只显示 Excel 和工序资料评分。等待时退出应用或后端重启可重新登录继续；生成成功或取消清理临时图，生成失败可恢复。0.1.2 和更早桌面端仍能使用新版后端的原自动生成流程。

Mac 云端包：`desktop/release/cloud/CKD-SOP-Cloud-0.1.3-mac-arm64.zip`。Windows 独立源码包：`desktop/release/cloud/CKD-SOP-Cloud-Windows-Source-0.1.3.zip`。Windows 用户解压后进入 `ckd-sop-desktop`，运行 `npm.cmd ci` 和 `npm.cmd run pack:win:cloud`，得到 `release/cloud/CKD-SOP-Cloud-0.1.3-win-x64.exe`。Windows 安装包需要在 Windows x64 上构建，本机没有宣称实机验证。

先更新云端后端，再安装 0.1.3 客户端；新客户端调用了图片确认接口。服务器在 `/opt/pi-patrick` 更新代码后执行 `npm ci`、`npm run build`，再按现有 systemd 服务方式重启。新增的 sharp 是平台原生依赖，不能把 Mac 的 `node_modules` 复制到 Ubuntu。更新代码及 Windows 客户端不自动同步，参见 [VPS 部署与维护](vps-deployment.md)。

## 0.1.4：工序评分明细展开（2026-10-14）

完成页的“工序资料评分”可点击每条工序，展开查看现有后端返回的评分原因、四项扣分依据、总扣分、资料来源和警告。分数及生成流程不变；历史任务只要保存了这些字段也能展开。此版本仅更新桌面界面，不需要重新上传或重启云端后端。

Mac 云端包：`desktop/release/cloud/CKD-SOP-Cloud-0.1.4-mac-arm64.zip`。Windows 独立源码包：`desktop/release/cloud/CKD-SOP-Cloud-Windows-Source-0.1.4.zip`。Windows 用户解压后进入 `ckd-sop-desktop`，运行 `npm.cmd ci` 和 `npm.cmd run pack:win:cloud`，得到 `release/cloud/CKD-SOP-Cloud-0.1.4-win-x64.exe`。Mac 包未签名；Windows 安装包仍需在 Windows x64 上构建和验证。

## 0.1.5：回收站与大图预览（2026-10-28）

最近任务右侧可删除到回收站、恢复；不永久删除任务/Excel，不释放硬盘空间。运行中的任务禁止删除。新增客户端接口要求先升级后端。图片显示最长边1600，实际裁剪及Excel保留原始像素；裁剪窗口显示原图保留尺寸，旧失败预览可点击“重试预览”，不重跑评分。

本轮Mac ARM64云端ZIP位于desktop/release/cloud/CKD-SOP-Cloud-0.1.5-mac-arm64.zip；Windows x64 NSIS安装包为desktop/release/cloud/CKD-SOP-Cloud-0.1.5-win-x64.exe，已在Mac交叉构建、核验asar及云端地址，未做Windows实机测试。两者SHA256见同目录CKD-SOP-Cloud-0.1.5-SHA256.txt。已安装客户端不会自动更新。

## 0.1.6：Excel 提前下载与检查进度（2026-11-03）

先升级后端，再安装0.1.6。工作簿生成后可先保存，图片检查进度与当前文件单独显示；未完成、失败或取消的报告明确提示不能视为检查通过。原“图片确认/裁剪→生成”要求保留。旧客户端不发送提前交付能力头，保持旧的一次性交付行为，不会把未完成报告当成已完成。

Mac ARM64云端ZIP：desktop/release/cloud/CKD-SOP-Cloud-0.1.6-mac-arm64.zip；Windows x64 NSIS安装包：desktop/release/cloud/CKD-SOP-Cloud-0.1.6-win-x64.exe。Windows在Mac交叉构建，不代表Windows实机验证；Mac包未签名/公证。安装包内不包含模型密钥、Library或后端运行时。已安装版本不会自动更新。

### 0.1.6 Windows 免安装 ZIP（2026-11-03）

用户反馈重启后NSIS仍报“CKD SOP Cloud cannot be closed”。当前electron-builder 26.15.3的默认检测在PowerShell可用时按进程路径是否以安装目录开头判断，并非只匹配主EXE；尚未取得用户Windows进程/安装路径诊断，不能断定具体误判原因，也不能将其认定为仍有旧进程。

提供同一份win-unpacked的完整ZIP：`desktop/release/cloud/CKD-SOP-Cloud-0.1.6-win-x64-unpacked.zip`。全部解压后运行文件夹内的`CKD SOP Cloud.exe`，必须保留同目录的resources、DLL等文件，不能只复制EXE，也不要在压缩包内直接启动。它绕过NSIS安装/升级检测，不修改注册表安装项，不等于已修复安装器。已校验ZIP全部成员、关键文件存在及文件集合无.env/.data；Windows实际启动仍待用户验证。应用代码、版本、云端地址、VPS均未改变。
