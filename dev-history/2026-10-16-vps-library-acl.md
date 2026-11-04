# VPS Library 上传权限修复

管理员同步任务 `40152ad2-eb9e-4634-8106-dc6fcb2b2124` 在中英文同步 8/1349 时因 `EACCES: mkdir .../SQ610/assembly_test/CN_process/1` 失败。检查发现 `SQ610/assembly_test` 下 49 个条目为 root:root、目录模式 755；`ckd-sop` 只能读取，不能创建中文翻译目录。先将该上传子树归属改为 `ckd-sop`，确认 Library 内已无其他非服务账号所有的条目。

为处理后续 root/WinSCP 直接上传，在 Ubuntu 安装 `acl` 包，对 Library 现有条目设置 `u:ckd-sop:rwX`，对 1194 个目录设置 `default:u:ckd-sop:rwx`。修改前的 ACL 导出保存于 `/opt/pi-patrick-backups/library-acl-before-20261016.txt`。业务文件内容、同步任务状态及后端代码未修改；无需重启服务。

验证：root 在 Library 下用通常的 `umask 022` 新建两层目录和文件，`ckd-sop` 对目录和文件均通过可写检查，并成功追加文件；测试目录清理完毕。直接从 Library 外移动文件或上传后显式修改权限可能绕过默认 ACL，需要重新应用规则。原失败任务由用户在 Web 点击“恢复同步”。
