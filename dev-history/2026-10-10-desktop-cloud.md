# 2026-10-10：Mac 云端客户端

用户要求先使用Mac测试VPS，并说明后续Mac/Windows重打包和更新关系。本次仅修改pi-patrick中的桌面构建配置、主进程配置读取/窗口标题、npm命令及文档；不修改patrick-agent、不部署/重启VPS，不改正式Library或任务。

新增desktop/electron-builder.cloud.cjs，继承原打包配置、内置http://8.133.254.83至package元数据。独立com.patrick.ckdsop.cloud、ckd-sop-desktop-cloud、CKD SOP Cloud和release/cloud；main优先读取打包地址，原config.json仍为127.0.0.1:4317。窗口标题固定为profile名称，以区分本机/云端。登录令牌/下载/IPC/隔离与沙箱逻辑不变，无新设置项或自动更新。

根目录命令desktop:pack:mac:cloud、desktop:pack:win:cloud；版本继承desktop/package.json，后续通过npm --prefix desktop version patch --no-git-tag-version同步该包版本与锁文件。Windows原生构建，未声称Mac交叉构建已验证。

初次默认Electron下载发生TLS连接中断。项目node_modules/electron当时没有dist；核对既有44.7.0-darwin-arm64 ZIP与npm包checksums.json SHA-256一致后，恢复项目内Electron运行包。cloud profile复用node_modules/electron/dist，Mac与Windows按原生平台安装依赖后构建。

交付：desktop/release/cloud/mac-arm64/CKD SOP Cloud.app，desktop/release/cloud/CKD-SOP-Cloud-0.1.0-mac-arm64.zip（128078515字节，约122MiB）。原本机包和config地址保留。未签名公证、未构建Windows包。

验证：构建成功；检查asar仅含main/preload/backend/saved-files/config/package及ui三文件，包内地址正确，云端身份独立；没有node_modules/Library/.env/Agent。包内Electron44.7.0与BackendClient真实公网登录111、libraryReady=true、列出2任务并退出成功，未运行模型或创建任务。应用已用open启动供用户测试，不自动操作GUI生成/原生保存。桌面3项传输/下载/路径保护测试、typecheck/build、JS语法与diff检查通过。README、VPS文档、core-changelog及desktop-releases同步说明两端独立更新和原生打包命令。

后续用户使用空白Windows电脑，另提供独立Windows构建源码ZIP（13文件、50295字节），含desktop源码/锁文件和README-Windows，排除依赖/密钥/业务数据；ZIP完整性检查通过。安装Node24LTS x64，在包目录用npm.cmd ci及npm.cmd run pack:win:cloud。未因此生成Windows二进制或声称Windows验证通过，无云端代码/配置改动。

Windows用户Node25.2/npm11.6.2执行npm ci成功，但electron/dist不存在，打包被固定路径配置阻断。查实际Electron44.7包没有postinstall，官方文档说明按需下载；此前“npm ci安装运行包”的解释有误。修正cloud prepack显式调用Electron install.js，并使用hook检查本平台/架构/版本与可执行文件；缺失、部分安装、旧版本或异平台回退默认下载。增加临时目录配置回归测试，覆盖上述分支；桌面4/4通过，Mac重新打包成功。向用户给出旧包原地补装命令，重新生成Windows源码r2 ZIP，不修改云端或评分/流程，也未实测Windows打包成功。
