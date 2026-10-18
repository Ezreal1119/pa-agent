# Ubuntu 24 VPS 原生部署

目标目录 `/opt/ProductExpertCloud`，Node >=22.19（当前 VPS 22.23.2）、Python 3.12。无 Docker：`FILE_WORKER_IMAGE` 不设置或为空，即使用每任务一个原生子进程，支持 production。主服务和文件任务一起由 systemd 管理。此文为配置步骤，不表示用户 VPS 已完成验收。

## 代码和数据

代码在 `feature/vps-native-deploy`；先在开发机审查、提交并推送本轮改动，VPS 再 `git pull --ff-only`。知识库、.env 不入 Git。将完整 `urovo-product-expert/` 和 `ums-expert/` 复制到 `.data/`；产品 MEMORY 必须随产品目录复制，UMS 不加载专属 MEMORY。共享 extra memory 可从空开始，专用 memory 工具首次实际操作时创建；不要求复制旧 sessions/files。

## 依赖与配置（VPS）

```sh
cd /opt/ProductExpertCloud
apt update
apt install -y python3-venv ca-certificates libstdc++6 libatomic1
# 文档中文渲染需要字体时：apt install -y fonts-noto-cjk
npm ci
npm run build
python3 -m venv /opt/ProductExpertCloud/.data/file-runtime
.data/file-runtime/bin/python -m pip install --no-cache-dir -r requirements-files.txt
.data/file-runtime/bin/markitdown --help
```

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

模板适配已提供的约 1.6GiB VPS：主进程 JS 堆256MiB、每 worker JS 堆384MiB；整个服务及全部子进程共 MemoryHigh=900M、MemoryMax=1100M、MemorySwapMax=256M、CPUQuota=150%、TasksMax=96。这些不是最大文件一定可处理的承诺。OOM 时整组结束，systemd 按 on-failure 重启，正在进行的 run 会中断。文件队列仍只执行一个重任务。

ProtectSystem=strict，只开放 `.data/` 写入，再把产品知识、可选 UMS 和转换器环境设为 ReadOnlyPaths；共享 memory、sessions、files、维护备份和设置仍可写。PrivateTmp、无额外 capabilities、NoNewPrivileges 一并启用。管理员在服务外仍能维护文件。这里是整个服务的权限边界，并非每个 worker 只能看见 job 目录；worker 仍能读取同账号可读文件，仍可联网，主进程也需要访问模型 API。参考 [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) 和 [resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)。

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

浏览器打开 `http://127.0.0.1:4321/`。服务端当前 Host 校验只允许实际服务端口，因此隧道两端均用4321，本机该端口必须空闲；服务端和本机一起修改 WEB_PORT 才能换用其他端口。不要直接公开4321端口；域名反代需另行适配/验证 Host 和 Origin。登录后测试真实问答、五类附件读取、Excel 输出下载及重启历史恢复。命令行夹具通过不等于真实模型/VPS24小时验收。

## 日常更新（VPS root）

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
