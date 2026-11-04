# 2026-10-14：VPS Catalog 清单读取权限

桌面端新建 SOP 时返回 `EACCES: permission denied, open '/opt/pi-patrick/resources/workflows/create-ckd-sop/build-ckd-catalog-v3/script.json'`。服务以 `ckd-sop` 账号运行，而该文件在 Mac 源目录和服务器上均是 `600`，服务器副本仍由上传者 UID 501 持有；其上级目录可遍历。部署采用保留权限的 rsync，因而服务账号无法打开文件。

只将该代码资源的 Mac 与服务器权限改为 `644`。服务器修改前后 SHA-256 均为 `f62b804c4bbb20d89bd06c7365b76463beac974b06e776210fcb077af3a40e42`；`runuser -u ckd-sop -- test -r` 通过，全体 `resources` 文件没有其他缺少全局读权限的条目，服务保持 active。`docs/vps-deployment.md` 已在权限整理后加入显式可读检查。未修改文件内容、Library、模型配置、任务或桌面安装包；用户需重新提交新建任务验证完整流程。
