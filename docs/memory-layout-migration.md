# Cloud 记忆目录迁移

本次仅修改代码和部署模板，不会自动移动、合并或删除实际记忆。Cloud是记忆的唯一准源，不用Mac记忆覆盖Cloud。新代码只读取新路径，没有旧路径回退。

```text
.data/memory/urovo-product-expert/
├── MEMORY.md        # 必需，主记忆，只读
└── MEMORY_EXTRA.md  # 可选，额外记忆，memory工具可写
```

`SKILL.md`和知识正文继续留在`.data/urovo-product-expert/`，UMS仍按需加载，不新增UMS记忆注入。主记忆与额外记忆的上下文分段、顺序、每轮新快照和同轮固定快照保持不变。备份仍在`.data/maintenance-backups/extra-memory/`。

## 1. 本地提交并推送代码

检查当前分支和改动后提交、推送；不提交`.data/`和`.env`。本轮不需要改.env，也没有新依赖。

## 2. VPS停服务并备份Cloud原件

以下以用户现有root运行方式为准。先停服务，在迁移和systemd保护调整完成前不要启动。

```sh
systemctl stop product-expert.service
cd /opt/ProductExpertCloud
memory_backup=".data/maintenance-backups/memory-layout-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$memory_backup"
cp -p .data/urovo-product-expert/MEMORY.md "$memory_backup/MEMORY.md"
if [ -f .data/memory/MEMORY.md ]; then
  cp -p .data/memory/MEMORY.md "$memory_backup/MEMORY_EXTRA.md"
fi
```

确认主记忆已备份。原来有额外记忆时，也必须有对应备份。任一步报错先处理，不继续迁移。

## 3. 更新代码并迁移文件

```sh
git pull --ff-only
npm run build
npm test
mkdir -p .data/memory/urovo-product-expert
```

**先检查目标目录；若已有MEMORY.md或MEMORY_EXTRA.md，停止并比较内容，不能直接覆盖。**以下`mv -n`也会拒绝覆盖已有目标；如果跳过，旧文件仍在，不能当作迁移完成。

```sh
mv -n .data/urovo-product-expert/MEMORY.md .data/memory/urovo-product-expert/MEMORY.md
if [ -f .data/memory/MEMORY.md ]; then
  mv -n .data/memory/MEMORY.md .data/memory/urovo-product-expert/MEMORY_EXTRA.md
fi
chown -R root:root .data/memory/urovo-product-expert
chmod 700 .data/memory/urovo-product-expert
chmod 600 .data/memory/urovo-product-expert/MEMORY.md
if [ -f .data/memory/urovo-product-expert/MEMORY_EXTRA.md ]; then
  chmod 600 .data/memory/urovo-product-expert/MEMORY_EXTRA.md
fi
ls -lh .data/memory/urovo-product-expert/
```

原来没有额外记忆时无需手工初始化；第一次成功调用memory add会创建新额外记忆文件。主记忆必须存在且非空。请核对迁移后的文件与备份内容一致，旧路径已搬走。

## 4. 调整实际systemd配置

```sh
systemctl edit --full product-expert.service
```

把旧主记忆的ReadOnlyPaths行替换为：

```ini
ReadOnlyPaths=-/opt/ProductExpertCloud/.data/memory/urovo-product-expert/MEMORY.md
```

保持`ReadWritePaths=/opt/ProductExpertCloud/.data`及其他保护项，保留当前User=root/Group=root。不能把整个memory目录或urovo-product-expert记忆子目录设为只读，MEMORY_EXTRA.md需要写入。无需改变WeCom Bridge配置。

## 5. 启动并检查

```sh
systemctl daemon-reload
systemctl restart product-expert.service
systemctl status product-expert.service --no-pager
```

Web登录后检查状态、发一个普通问题，确认知识与记忆正常注入。需要验证记忆写入时，明确请求记录一条测试记忆，然后删除该条；只有MEMORY_EXTRA.md应改变，主MEMORY.md保持与备份一致。历史会话不重写；新run读取新路径。

## 后续维护

- 停止Mac的`product_docs_sync.py`中单独复制主MEMORY的步骤；旧脚本会重新生成旧位置的MEMORY.md，新服务不会读取它。
- 现有Synchronize维护的Cloud正式知识目录也不应再用旧脚本/rsync整体覆盖。新增资料上传Synchronize或投递newly_added。
- 不从Mac上传memory目录或旧位置MEMORY.md来覆盖Cloud。确有需要时，从Cloud下载记忆副本供本地查看。
- 本轮未修改Git忽略的本地同步脚本、实际记忆文件、.env或远程VPS。旧备份继续保留，迁移不清理历史报告/聊天。

如需回退，先停服务，把当前新位置的两份记忆（包括迁移后新增内容）备份并搬回旧路径，恢复旧代码和旧主记忆保护项后再启动；不要直接用旧备份覆盖迁移后产生的新记忆。
