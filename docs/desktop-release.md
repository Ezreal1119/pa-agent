# CKD SOP 桌面端发版步骤

本文用于 Windows 桌面客户端发版。示例版本 `0.1.13`，实际操作时替换成目标版本。

## 一、准备

- Windows 打包机；
- 仓库目录：`D:\pa-agent`；
- Node.js 22 + npm；
- 服务器：`8.133.254.83`；
- 服务器安装包目录：`/opt/pi-patrick/downloads/`；
- 下载地址前缀：`https://ckd-sop.patrick-shenzhen.cn/downloads/`。

## 二、修改版本号

```powershell
cd D:\pa-agent\desktop
npm version 0.1.13 --no-git-tag-version
```

确认 `desktop\package.json` 的 `version` 已更新，然后提交：

```powershell
cd D:\pa-agent
git add desktop/package.json desktop/package-lock.json
git commit -m "chore: package desktop 0.1.13"
git push origin create-ckd-sop
```

## 三、打包

```powershell
cd D:\pa-agent\desktop
npm ci
npm run pack:win:cloud
```

产物：

```
D:\pa-agent\desktop\release\cloud\CKD-SOP-Cloud-0.1.13-win-x64.exe
```

记录大小和 SHA256：

```powershell
Get-Item .\release\cloud\CKD-SOP-Cloud-0.1.13-win-x64.exe | Select-Object Length
Get-FileHash .\release\cloud\CKD-SOP-Cloud-0.1.13-win-x64.exe -Algorithm SHA256
```

## 四、上传到服务器

1. 打开 WinSCP，协议 `SFTP`，主机 `8.133.254.83`，端口 `22`，用户 `root`；
2. 左侧进入：

```
D:\pa-agent\desktop\release\cloud
```

3. 右侧进入：

```
/opt/pi-patrick/downloads
```

4. 把 `CKD-SOP-Cloud-0.1.13-win-x64.exe` 拖到右侧；
5. 上传完成后，在服务器终端执行：

```bash
chmod 644 /opt/pi-patrick/downloads/CKD-SOP-Cloud-0.1.13-win-x64.exe
ls -lh /opt/pi-patrick/downloads/
```

## 五、更新服务器版本配置

用 WinSCP 编辑 `/opt/pi-patrick/.env`，或 SSH 登录后执行 `sudo nano /opt/pi-patrick/.env`。

加入或修改：

```bash
CKD_DESKTOP_VERSION=0.1.13
CKD_DESKTOP_MIN_VERSION=0.1.10
CKD_DESKTOP_DOWNLOAD_URL=https://ckd-sop.patrick-shenzhen.cn/downloads/CKD-SOP-Cloud-0.1.13-win-x64.exe
```

说明：

- `CKD_DESKTOP_VERSION`：最新版本号；
- `CKD_DESKTOP_MIN_VERSION`：低于它的客户端提示“已不再支持”；
- `CKD_DESKTOP_DOWNLOAD_URL`：点「查看更新」打开的地址。

## 六、重启服务

如果这次也改了服务端代码：

```bash
cd /opt/pi-patrick
git pull --ff-only
npm ci
npm run build
sudo systemctl restart ckd-sop
```

如果只发桌面端、没改服务端代码，也建议重启一次让 `.env` 生效：

```bash
sudo systemctl restart ckd-sop
```

## 七、验证

检查安装包下载：

```bash
curl -I https://ckd-sop.patrick-shenzhen.cn/downloads/CKD-SOP-Cloud-0.1.13-win-x64.exe
```

应返回 `200 OK`，`Content-Length` 与安装包大小一致。

检查版本接口：

```bash
curl -s http://127.0.0.1:4317/api/client/version
```

应返回类似：

```json
{"latest":"0.1.13","minimum":"0.1.10","downloadUrl":"https://ckd-sop.patrick-shenzhen.cn/downloads/CKD-SOP-Cloud-0.1.13-win-x64.exe","notes":""}
```

## 八、通知使用方

- 0.1.12 及以后版本会自动看到「发现新版本」；
- 0.1.11 及更早版本没有版本检查，需要手动把安装包发给他们；
- 安装包未签名时，Windows 可能提示 SmartScreen，选择「更多信息 → 仍要运行」。

## 九、回滚

保留上一版安装包和 `.env` 配置。出问题时把 `CKD_DESKTOP_VERSION`、`CKD_DESKTOP_DOWNLOAD_URL` 改回上一版，然后：

```bash
sudo systemctl restart ckd-sop
```
