# Ubuntu 24 VPS 原生部署

目标目录 `/opt/ProductExpertCloud`，Node >=22.19（当前 VPS 22.23.2）、Python 3.12。无 Docker：`FILE_WORKER_IMAGE` 不设置或为空，即使用每任务一个原生子进程，支持 production。主服务和文件任务一起由 systemd 管理。此文为配置步骤，不表示用户 VPS 已完成验收。

## 代码和数据

代码在 `feature/vps-native-deploy`；先在开发机审查、提交并推送本轮改动，VPS 再 `git pull --ff-only`。知识库、.env 不入 Git。将完整 `urovo-product-expert/` 和 `ums-expert/` 复制到 `.data/`；产品主记忆放在 `.data/memory/urovo-product-expert/MEMORY.md`，不再放在产品资料目录，UMS 不加载专属 MEMORY。额外记忆位于 `.data/memory/urovo-product-expert/MEMORY_EXTRA.md`，首次部署可从空开始；已有VPS记忆以Cloud为准，迁移见 [记忆目录迁移](memory-layout-migration.md)。缺失的额外记忆由专用 memory 工具首次实际操作时创建；不要求复制旧 sessions/files。

## 依赖与配置（VPS）

```sh
cd /opt/ProductExpertCloud
apt update
apt install -y python3-venv ca-certificates libstdc++6 libatomic1 ripgrep fd-find
# 文档中文渲染需要字体时：apt install -y fonts-noto-cjk
npm ci
npm run build
python3 -m venv /opt/ProductExpertCloud/.data/file-runtime
.data/file-runtime/bin/python -m pip install --no-cache-dir -r requirements-files.txt
.data/file-runtime/bin/markitdown --help
```

`ripgrep` 和 `fd-find` 是 Pi 的 grep/find 检索依赖（Ubuntu 命令为 rg/fdfind，SDK 均可识别），需预装以避免运行时尝试下载而长时间等待。

`.env` 填写 API_KEY、BASE_URL、MODEL_ID、ADMIN_ACCOUNT、ADMIN_PASSWORD，以及独立 VISION_LLM_*。路径：

```ini
AGENT_CWD=/opt/ProductExpertCloud
AGENT_DATA_DIR=/opt/ProductExpertCloud/.data
MARKITDOWN_COMMAND=/opt/ProductExpertCloud/.data/file-runtime/bin/markitdown
FILE_TOOLS_ENABLED=true
WEB_PORT=4321
```

不要设置 FILE_WORKER_IMAGE。默认六文件工具开启；若迁移过 `.data/web-agent-settings.json`，保存的偏好优先于 env 的初始开关。服务的 NODE_ENV=production 由 unit 设置，无需绕过生产模式。

## 启动账号和 systemd（VPS root）

以下为专用服务账号；Git、依赖、构建仍由管理员维护，服务不需要 sudo、Docker 或 Git 凭据。

```sh
cd /opt/ProductExpertCloud
id productexpert || useradd --system --user-group --home-dir /opt/ProductExpertCloud/.data/agent --no-create-home --shell /usr/sbin/nologin productexpert
chown -R productexpert:productexpert .data
chmod 700 .data
chown root:productexpert .env
chmod 640 .env

# Node 必须在服务 PATH 中，不能只在 root 的 nvm 目录里。
runuser -u productexpert -- /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin node --version

install -m 644 deploy/product-expert.service /etc/systemd/system/product-expert.service
systemd-analyze verify /etc/systemd/system/product-expert.service
systemctl daemon-reload
systemctl enable --now product-expert.service
systemctl status product-expert.service --no-pager
journalctl -u product-expert.service -n 80 --no-pager
```

若 Node 检查失败，先提供系统范围内的 Node >=22.19，再启动。普通账号必须能读取项目代码及所有上级目录。unit 的 ProtectHome=yes 不支持把 Node/Python 或运行资源放在 /root、/home 下。不要为了让它启动改为 root。

模板适配 2 vCPU / 4 GiB VPS：主进程 JS 堆1024MiB、每 worker JS 堆384MiB；整个服务及全部子进程共 MemoryHigh=2200M、MemoryMax=2600M、MemorySwapMax=512M、CPUQuota=150%、TasksMax=192。大幅面 PDF 转换 worker 实测峰值约 0.7 GB（画布像素不受 JS 堆限制）；原 1.6GiB 配置的 1100M 上限会把它杀掉。这些不是最大文件一定可处理的承诺。OOM 时整组结束，systemd 按 on-failure 重启，正在进行的 run 会中断。文件队列仍只执行一个重任务。

### 主进程内存与登录升级

2026-10-23 VPS 日志显示主进程在约 256 MiB JS 堆上限连续 OOM，虽然机器仍有可用物理内存。新模板将主进程堆上限调到 1024 MiB；不提高整个服务的 MemoryMax，不修改导入 timer、worker 上限或重任务串行队列。旧报告轮询反复读取、复制、发送整份差异的路径也已改为摘要，差异和覆盖检查按展开加载；Token 进度最多每秒合并一次落盘，阶段切换、发布、停止和退出仍等待保存。

已有 VPS 推荐只装下面的 drop-in，保留当前 root/productexpert 运行账号、ProtectHome、ReadWritePaths 和其他本地配置。先由管理员提交/推送代码；在 VPS 执行：

```bash
cd /opt/ProductExpertCloud
git pull --ff-only
npm run build
install -d -o root -g root -m 0755 /etc/systemd/system/product-expert.service.d
install -o root -g root -m 0644 deploy/product-expert-memory.conf /etc/systemd/system/product-expert.service.d/20-memory.conf
systemctl daemon-reload
systemctl restart product-expert.service
systemctl show product-expert.service -p ExecStart -p MemoryHigh -p MemoryMax
```

确认 ExecStart 含 `--max-old-space-size=1024`；若另有覆盖 ExecStart 的更后序本地 drop-in，以 `systemctl cat product-expert.service` 检查并由管理员合并。此次没有新依赖，已有 node_modules 正常时不必重新 `npm ci`。单纯拉代码或 build 不会改变 VPS 正在使用的 systemd 内存参数。安装模板不由应用自动执行。

登录会话现在保存到 `.data/web-auth/sessions.json`：最多 128 条令牌 SHA256 摘要和原过期时间，使用由管理员凭据派生的密钥校验 HMAC；不保存原始 Cookie、账号密码或模型凭据。文件及原子临时文件为 0600，目录为 0700，符号链接/硬链接/过大或损坏格式拒绝加载。更换管理员凭据会使旧签名失效；退出登录持久撤销该 Cookie。七天从登录起算，不因重启或普通访问续期。首次升级以前的内存会话无法从 Cookie 反推恢复，因此需要重新登录一次；之后的服务重启保留有效登录。服务重启仍更换 CSRF Token，旧页面若遇 403，只需刷新页面，无需放宽校验或自动重放保存请求。不要将此文件加入 Git，也不要在多个 Web 进程间共用它。

本机 Node 22.23.2 合成压测：12 项差异、约 26.9 MB 完整报告，4 路并发、64 次读取；旧完整视图每次 26,934,839 bytes、峰值 RSS 1369 MiB，新摘要每次 7,715 bytes、峰值 RSS 190 MiB。两个独立进程均使用 1024 MiB 堆，包含初始化开销；通过 `node scripts/profile-sync-reports.mjs` 可在隔离临时目录重现，结果保存 `.data/debug/report-profile.json`。这些是合成报告的读取/序列化结果，不是正式 VPS、真实模型或整机同时转换文件的内存承诺。单次显式展开旧报告仍需解析该报告 JSON，但串行执行且不复制返回其他正文；超大单份历史报告、模型上下文和原生 worker 仍会占用内存，部署后继续观察日志。

### 服务权限

ProtectSystem=strict，只开放 `.data/` 写入，再把产品SKILL/SYNC_PROMPT、可选UMS和转换器环境设为ReadOnlyPaths；产品资料由Synchronize维护，MEMORY_EXTRA、sessions、files、维护备份和设置仍可写。PrivateTmp、无额外 capabilities、NoNewPrivileges 一并启用。管理员在服务外仍能维护文件。这里是整个服务的权限边界，并非每个 worker 只能看见 job 目录；worker 仍能读取同账号可读文件，仍可联网，主进程也需要访问模型 API。参考 [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) 和 [resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)。

## 验证（VPS 与 Mac）

```sh
# VPS：无模型凭据的生成夹具测试，验证六工具、取消、保护原件和原生 production 路径。
cd /opt/ProductExpertCloud
NODE_ENV=production FILE_WORKER_IMAGE= FILE_TEST_MARKITDOWN=/opt/ProductExpertCloud/.data/file-runtime/bin/markitdown node --test tests/file-tools.test.mjs

# VPS：限制实际加载值和本机页面。
systemctl show product-expert -p User -p MemoryHigh -p MemoryMax -p MemorySwapMax -p TasksMax
curl -I http://127.0.0.1:4321/login
```

```sh
# Mac：先停止本机4321测试服务，VPS_IP 换成真实地址。
ssh -N -L 4321:127.0.0.1:4321 root@VPS_IP
```

浏览器打开 `http://127.0.0.1:4321/`。服务端当前 Host 校验只允许实际服务端口，因此隧道两端均用4321，本机该端口必须空闲；服务端和本机一起修改 WEB_PORT 才能换用其他端口。不要直接公开4321端口；HTTPS 域名反代按下方 WEB_PUBLIC_URL 配置。登录后测试真实问答、五类附件读取、Excel 输出下载及重启历史恢复。命令行夹具通过不等于真实模型/VPS24小时验收。

## HTTPS 域名访问

如果使用域名 `https://urovo-agent.patrick-shenzhen.cn` 访问，请在 VPS 现有 `.env` 中追加来源地址（不含 `/login`）：

```ini
WEB_PUBLIC_URL=https://urovo-agent.patrick-shenzhen.cn
```

同步本次代码、构建与测试后，执行 `systemctl restart product-expert.service` 并刷新登录页。这个配置只影响 Web/Agent，不需要重启独立的 `wecom-bridge.service`。不填该字段则仍仅允许本机 HTTP 来源；模型凭据、Web 密码和企微 API 凭据不变。

后端继续只监听 `127.0.0.1:4321`。显式公开地址允许 HTTPS 来源，兼容反代保留公共 Host 或改写为本机 Host，且不从任意 `X-Forwarded-*` 自动推断可信地址。登录和退出的公开 HTTPS 请求设置 Secure Cookie；本机 HTTP 调试仍可用。来源、管理员登录和修改请求的 X-Local-Token 均保留，不启用通配符跨域。

若使用 Nginx，在**现有 HTTPS server** 中合并以下 location 配置，证书/域名继续用你已有设置；保留浏览器原始 Origin：

```nginx
client_max_body_size 100m;

location ^~ /api/wecom/ {
    return 404;
}

location / {
    proxy_pass http://127.0.0.1:4321;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 1000s;
}
```

`/api/wecom/` 留给同机 Bridge；Web 的普通 API、SSE 和附件通过上方普通代理转发。`client_max_body_size 100m` 允许 Synchronize 最高100MiB上传，聊天附件仍由后端单独限制为30MiB。已有30m配置需要改这一行并在 `nginx -t` 通过后reload；无需因此修改.env。参考 [Nginx 官方代理模块文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。已有反代能打开页面时，先更新代码和 `.env`；无需为了来源修复去覆盖现有证书或整段反代配置。

## 日常更新（VPS root）

Office XML 编码兼容的定向验证直接运行 `npm run test:office-xml`；命令会先构建，再自动设置 production 与无 Docker 测试环境。完整回归仍使用 `npm test`，无需记忆测试文件名或手工设置环境变量。这里的环境变量只对测试进程生效，不改写 `.env` 或 systemd 配置。

```sh
cd /opt/ProductExpertCloud
git pull --ff-only
systemctl stop product-expert
npm ci
npm run build
systemctl start product-expert
systemctl status product-expert --no-pager
```

若本轮更新 Python 依赖，再执行虚拟环境 pip install；若更新 unit，重新 install、daemon-reload 后 restart。知识库更新也使用管理员权限，不通过 Agent 写入。已有 active runs 时先等其完成，再执行更新；安装或构建失败时先修复，避免启动不完整的版本。`.data/` 和 `.env` 单独备份，不用 Git 备份。

## Synchronize 升级补充

手动知识库维护入口 `/synchronize` 由原 product-expert 服务管理。新增原生 LibreOffice Writer/Calc/Impress、Fontconfig、Noto CJK/Liberation 字体和 ripgrep；安装、环境检查及资源限制见 [Synchronize 部署步骤](synchronize.md#ubuntu-24-原生部署)。运行 `npm run check:sync` 和 `npm run test:sync`。

本次必须调整 unit：移除产品库整个目录的 ReadOnlyPaths，改为保护该库根 SKILL.md/SYNC_PROMPT.md；Memory Injection需要解除新旧主MEMORY文件的只读挂载；保留 UMS/file-runtime 的只读项，TasksMax=192。保留现有 User/Group（尤其是已选择 root 的部署），然后 daemon-reload/restart。未完成这些调整时发布会因只读目录失败，原件保留。正式启用后不要继续用旧同步脚本或 rsync 直接覆盖该知识库；外部文件只投递到 newly_added。


主记忆管理员维护入口已提供：部署时须删除主MEMORY.md的单文件ReadOnlyPaths，否则原子保存会失败；不是取消SKILL、UMS或运行依赖的保护。详见 [Memory Injection](memory-injection.md)。无需改.env或安装新依赖。


## Optional manual SFTP collection

After updating this feature, run `npm ci` before building; it adds `ssh2` and a cross-process file lock. No Docker, extra systemd service, timer or WeCom configuration is needed. Add the `SFTP_*` credentials/pinned host key to the VPS's existing `.env`, create `.data/sftp_sync_paths.jsonl`, then restart `product-expert.service`. Use **Synchronize → Source imports** or `npm run sftp:sync`. Keep these VPS credentials and `.data/logs/sftp_sync/` state out of Git and Mac data sync. Detailed account example and recovery: [manual SFTP imports](sftp-sync.md).
