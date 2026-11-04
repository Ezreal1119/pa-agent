# Ubuntu VPS 部署与维护

服务器：`8.133.254.83`，Ubuntu 24.04 x64，Node 22；项目：`/opt/pi-patrick`。
按用户要求只使用 **IP + HTTP**，客户端后端地址为 `http://8.133.254.83`，不启用 HTTPS 或证书续期。

## 首次上传与离线迁移

首次全量上传可以包含 `.env`、`.data` 和 desktop 源码；排除 Mac 的 `node_modules`，在 Ubuntu 执行 `npm ci`。服务器不需要安装/运行 Electron，也不能把项目作为 Nginx 静态目录发布。

旧任务、脚本收据和译文注册表包含 Mac 绝对路径，只改 `.env` 不足以迁移。迁移器须在服务停止、无 Library 写入时执行。先保存完整备份：

```bash
cd /opt/pi-patrick
umask 077
backup=$(mktemp -d /opt/pi-patrick-backups/migration.XXXXXX)
tar -cf "$backup/data-and-env.tar" .data .env
sha256sum "$backup/data-and-env.tar" > "$backup/SHA256SUMS"

node deploy/migrate-data.mjs --root /opt/pi-patrick --from /Users/patrickxu/pi-patrick
node deploy/migrate-data.mjs --root /opt/pi-patrick --from /Users/patrickxu/pi-patrick \
  --apply --backup "$backup/metadata"
```

默认只预览。执行前验证 Catalog、脚本产物 Hash，保存元数据原件后迁移任务路径、Catalog Hash、收据校验和、脚本缓存键、会话头 cwd、维护任务路径及按 Library 路径定位的译文注册表。原路径注册表保留；内容 Hash 不改。Library、Excel、图片成功/失败缓存、校准数据、会话对话原文、问题 ID 和历史归档不回写。维护/预分析不自动重新启动；澄清任务继续等待原问题。

仅支持当前默认 Library 布局，复制的锁和未完成 Library 事务会拒绝迁移。工具捕获错误时回滚本次元数据；断电、强制杀进程或文件系统故障应停服并从外部 tar 恢复，不能在服务运行中覆盖旧数据。

本次服务器备份目录为 `/opt/pi-patrick-backups/20261010-migration.X8B23p/`，包含 `.data`/`.env` 完整 tar、Hash 清单、元数据备份、测试日志和原 Nginx 配置，权限受限。

## 服务与 Nginx

`deploy/ckd-sop.service` 使用独立系统账号 `ckd-sop`、工作目录 `/opt/pi-patrick`、编译入口 `dist/ckd/ui.js`；监听 `127.0.0.1:4317`，开机启动、异常退出重启。代码由 root 持有并可读，`.data` 由服务账号持有且权限 700，`.env` 由服务账号持有且权限 600。

`.env` 由 dotenv 从工作目录读取，不通过 systemd EnvironmentFile 解释。服务显式配置服务器的 CKD_DATA_DIR 和 CKD_LIBRARY；迁移器同时迁移已有 AGENT_CWD/AGENT_DATA_DIR。

Library 在 VPS 上配置了 POSIX 默认 ACL：root/WinSCP 直接在 Library 中新建目录、上传文件时，`ckd-sop` 服务账号自动获得写权限；ACL 存在文件系统中，重启后保留。2026-10-16 安装了 Ubuntu `acl` 包，对现有 Library 设置访问 ACL，并对所有目录设置继承 ACL。此前由 root 上传、阻断中英文同步的 `product_lib/SQ610/assembly_test` 已修正归属。设置命令：

```bash
library=/opt/pi-patrick/.data/ckd/library/ckd-library-v2
setfacl -R -m u:ckd-sop:rwX "$library"
find "$library" -xdev -type d -exec setfacl -m d:u:ckd-sop:rwx {} +
getfacl -cp "$library"
```

已用 root 在 Library 下新建嵌套目录和文件、再由 `ckd-sop` 写入进行验证。若先上传到 Library 外再直接移动进来，或上传工具随后强制覆盖权限/ACL，新文件不会可靠地继承这套规则，应重新执行上述命令或在 WinSCP 关闭“保留权限”。修复前 ACL 已备份到 `/opt/pi-patrick-backups/library-acl-before-20261016.txt`。

```bash
systemctl status ckd-sop --no-pager
journalctl -u ckd-sop -n 50 --no-pager
curl -i http://127.0.0.1:4317/api/status
# 未登录的管理员接口应返回 401。
systemctl restart ckd-sop
```

重启使内存令牌失效，需要重新登录，不会自动恢复模型运行。旧任务和生成文件保留。3 个已完成任务使用过旧脚本版本，本机也有同样资产差异；仍能下载其文件，不改旧 Hash 冒充兼容。

Nginx 配置见 `deploy/ckd-sop-nginx.conf`。`/api/client/` 保持桌面专用；新增 `/admin/` 代理到同一后端，路径保持原样，内部 Host 为 `127.0.0.1:4317`。管理员页面、管理 API、图片预览和下载均使用 `/admin/` 前缀并验证独立登录。两个登录入口按来源 IP 限流。现有 `/` 上游继续指向 3000。

生产服务启动前在仅服务账号可读的 `/opt/pi-patrick/.env` 配置 `CKD_ADMIN_USER`、`CKD_ADMIN_PASSWORD_HASH`（随机盐 scrypt 格式）和 `CKD_ADMIN_ORIGIN=http://8.133.254.83`。缺少配置时生产服务拒绝启动。不要把明文密码写进代码、Nginx 配置或 Git。管理员会话只保存在后端内存，12 小时到期或服务重启后重新登录；Cookie 为 HttpOnly、SameSite=Strict。HTTP 登录内容和会话 Cookie 在网络中不加密，适用范围由用户确认。

保留原 `sites-enabled/api`、3000 上游、系统 Certbot 及已有证书。新增 IP 虚拟主机的其余路径仍代理原 3000 服务。没有新增 443 监听；阿里云安全组只需当前已开放的 TCP 80，4317 不需要开放。HTTP 流量没有 TLS 加密。

```bash
nginx -t
systemctl reload nginx
curl -i http://8.133.254.83/api/client/status
# 未登录应返回 401；这表明公网反代已到达后端。
```

管理员 API 需要登录后的 Cookie，本机通过 SSH 调用也一样。浏览器管理入口在 Nginx 配置后是 `http://8.133.254.83/admin/`。

```bash
curl -i http://127.0.0.1:4317/admin/api/status
# 未登录应返回 401。
```

Mac 现有 Web 仍操作 Mac 数据，并不会自动改连服务器。当前固定账号 111/222、单账号归属、12 小时会话沿用首版约定，没有增加正式多用户账号管理。

## 后续代码更新

### 当前方式：在 VPS 手动 Git 更新

`/opt/pi-patrick` 使用 GitHub `Ezreal1119/pa-agent` 的 `create-ckd-sop` 分支，采用快进拉取，不使用 Actions 或自动上线。开发者在自己的电脑提交并 push，服务器由管理员手动更新。服务器不要直接开发代码或提交业务资料。

先确认生成、图片检查和 Library 维护已结束，再在 VPS 执行：

```bash
cd /opt/pi-patrick
umask 022
git status --short
```

有未提交代码时先查明原因，不强行覆盖。确认更新窗口后执行下列整段；任一步失败都会停止后续步骤，修复或回退后再启动服务：

```bash
systemctl stop ckd-sop &&
git pull --ff-only &&
npm ci --include=dev --no-audit --no-fund &&
npm run build &&
systemctl start ckd-sop &&
systemctl is-active ckd-sop
```

停止服务期间网页和桌面连接暂时不可用。TypeScript 必须重新构建，只 pull/restart 不会更新已编译的后端。`--include=dev` 保证构建所需的 TypeScript 已安装；`umask 022` 保证独立服务账号能读取新代码和依赖。普通更新不需要重装 Electron、修改 Nginx 或触发整库同步；评分 Python 依赖发生变化时，按对应版本说明更新现有独立虚拟环境后再启动服务。

`.env`、`.data`（含 Library/任务/缓存）、`.venv-scoring` 和旧安装包不由 Git 管理，正常 pull 不覆盖它们；不要执行 `git clean -fdx`。服务器保留的旧资源目录 `resources/legacy/` 在本机 `.git/info/exclude` 中忽略，原始业务迁移清单也继续本机保存。它们不提交、不删除，不影响正常拉取。

首次切换 Git 管理时保留原提交、代码归档及工作树 Hash 供回退。旧任务的资源 Hash 会包含工作流目录中的说明/清单文件，因此本次对齐保留 `source-manifest.json` 原始字节和服务器现有的忽略清单；后续任何工作流资源变化仍遵守原有任务恢复校验，不强行改写旧快照。

下面的 rsync 章节保留为历史部署记录，日常代码更新使用上面的 Git 流程。

### 历史方式：rsync 更新

开始正式使用后，服务器 `.data` 是业务数据来源，不能再被 Mac 旧 `.data` 全量覆盖。密钥也不随代码更新覆盖。先等生成/维护结束，再停止服务并备份服务器数据和当前代码，保留可回滚版本。

Mac 仅上传代码；反斜线后不要加空格：

```bash
rsync -avz -e 'ssh -i /Users/patrickxu/.ssh/aliyun_ed25519' \
  --exclude='node_modules/' --exclude='.DS_Store' --exclude='.git/' \
  --exclude='.env' --exclude='.data/' --exclude='dist/' --exclude='desktop/release/' \
  /Users/patrickxu/pi-patrick/ root@8.133.254.83:/opt/pi-patrick/
```

此命令不删除服务器文件；删除源码/升级数据结构时按该版本迁移说明单独处理，不对业务目录使用 `--delete`。

Ubuntu 中更新依赖、检查和启动：

```bash
cd /opt/pi-patrick
umask 022
npm ci
npm run typecheck
npm run build
node --import tsx --test --test-concurrency=1 --test-timeout=120000 \
  tests/*.test.ts resources/workflows/create-ckd-sop/build-ckd-catalog-v3/test/*.cjs desktop/test/*.test.cjs
chown -R root:root node_modules dist resources
chmod -R a+rX node_modules dist resources
runuser -u ckd-sop -- test -r resources/workflows/create-ckd-sop/build-ckd-catalog-v3/script.json
chown -R ckd-sop:ckd-sop .data
chown ckd-sop:ckd-sop .env
chmod 700 .data
chmod 600 .env
systemctl restart ckd-sop
curl -i http://127.0.0.1:4317/api/status
# 未登录的管理员接口应返回 401。
```

两核 VPS 使用串行完整测试以避免并行资源竞争。失败先保留日志并回退代码、重新安装/编译；涉及数据变更的版本还须按备份回退数据。

Library 修改/增加/删除属于独立的数据维护：备份后修改目标语言文件，再在服务器本机调用已有 `/api/library/sync`，查询任务确认结果；代码上传不会自动触发。

## 桌面应用分发

桌面包只含界面，不含密钥/Library/后端。云端版使用 `desktop/electron-builder.cloud.cjs` 写入后端地址 `http://8.133.254.83`，Mac执行 `npm run desktop:pack:mac:cloud`，Windows x64机器执行 `npm run desktop:pack:win:cloud`。本机开发继续使用config.json，不覆盖本机包。修改地址或客户端不会更新已经安装的应用，需重新打包分发。详见 [桌面发布说明](desktop-releases.md)。Windows二进制及实机测试单独交付。


## 固定像素评分 V1.23.0

独立环境安装（不改变系统Python）：

```bash
python3 -m venv /opt/pi-patrick/.venv-scoring
/opt/pi-patrick/.venv-scoring/bin/python -m pip install --only-binary=:all: -r /opt/pi-patrick/resources/image-quality/v1.23.0/requirements.txt
```

通过systemd drop-in设置 `CKD_IMAGE_SCORER=pixel-v1.23.0`、`CKD_SCORER_PYTHON=/opt/pi-patrick/.venv-scoring/bin/python`。保留.env及VISION_*供独立AI工序重点检查；不把密钥复制到测试目录。代码rsync必须同时排除 `.venv-scoring/` 和 `__pycache__/`，不能复制Mac虚拟环境到Linux。

在独立staging目录验证后，等待活动任务完成，备份代码/配置/任务元数据，停服同步并构建。不可覆盖生产.data/.env，不自动启动全库同步。大图用原始像素评分、单并发、Linux2GiB限额；若资源超限，显示人工复核，不压缩/缩图冒充原结果。

新缓存独立，旧快照继续旧实现。回滚时恢复代码和systemd drop-in（`CKD_IMAGE_SCORER=legacy`），不删除新缓存、不回写旧报告。生产CLI建议通过`runuser -u ckd-sop -- env ...`执行；如需像素模式，也必须显式使用上述两个环境变量，服务的Environment不会自动传给SSH交互命令。评分锁/缓存兼容root与服务账号交替调用；通用Library/任务锁仍遵守原账号与目录权限约定。

VPS验证命令使用venv解释器：

```bash
/opt/pi-patrick/.venv-scoring/bin/python -B tests/pixel_v123_verify.py --handoff <验收目录> --large-manifest <大图manifest.json>
CKD_IMAGE_SCORER=legacy CKD_SCORER_PYTHON=/opt/pi-patrick/.venv-scoring/bin/python node --import tsx --test --test-concurrency=1 --test-timeout=120000 tests/*.test.ts resources/workflows/create-ckd-sop/build-ckd-catalog-v3/test/*.cjs desktop/test/*.test.cjs
```

完整回归默认legacy是为了验证旧接口；新增pixel测试通过显式选项启用新实现。验收报告见 `dev-history/2026-10-27-pixel-quality-v123.md`。
