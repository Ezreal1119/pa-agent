CKD SOP Cloud 0.1.4 - Windows x64 独立客户端源码

1. 解压本 ZIP，在 PowerShell 中进入本文件所在的 ckd-sop-desktop 文件夹。
2. 安装 Node.js 22.19 或更新版本（建议 24 LTS，x64）。
3. 运行：npm.cmd ci
4. 运行：npm.cmd run pack:win:cloud
5. 安装 release\cloud\CKD-SOP-Cloud-0.1.4-win-x64.exe。

客户端内置后端地址 http://8.133.254.83。本次只增加工序资料评分展开，现有支持图片确认的服务器无需更新；桌面端不包含后端、Library 或模型密钥。安装包未签名，Windows 实机验证仍由使用者完成。
