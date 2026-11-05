# 固件签名后缀优先与其他后缀回退

## 问题与行为

SQ47 的普通 `_rel.zip` 固件确实存在，但原结构化查询只接受 `_uFWsign_VendorEN.zip`，因此返回未找到。

- 继续精确匹配完整型号、六位日期与两位 index，不改变索引目录。
- 枚举全部索引目录后，有 `_uFWsign_VendorEN.zip`（忽略大小写）就只使用这一类；没有时，使用其他后缀的匹配 ZIP，包括 `_REL.zip`。
- 优先级选择在计数、截断和元信息读取前完成，不在第一目录或截断后的列表上判断是否需要回退。优先包元信息失败不会降级到其他包；查询不完整仍终止。
- 原 UFS、`_SE_OTA`、定制包排除保留；多个候选仍须选包，原用户确认后才创建传输。
- 查询协议为 `model_date_index_vendoren_preferred_and`，`selection=vendoren|fallback`。Agent 拒绝旧协议、混合优先级及优先级标记不符的候选。
- 未确认流程版本升为 4；旧流程提示重新发起，已确认并进入提交/运行/取消的任务继续使用原身份与幂等键。
- 未找到文案改为“未找到……的固件”，不再限定签名后缀。

## 验证

- 隔离工作树构建通过。
- `node --test tests/firmware*.test.mjs tests/wecom-commands.test.mjs tests/wecom-bridge.test.mjs`：74 项通过，零失败/跳过。
- 本机 Python 服务全套测试：65 项通过，零失败/跳过；其中结构化查询 9 项通过。覆盖真实临时服务器上的 REL 查询及下载、跨目录签名包优先、回退后的计数/截断、查询不完整和原排除规则。
- 本机服务重启后真实查询 `SQ47 / 260427_01`：`complete=true`、`selection=fallback`、`total=1`，返回 `SQ47_EN_XX_EX30_WE__DS__R01_U_260427_01_rel.zip`。新版云端客户端验证通过。正式包只查询，未提交下载、上传或发送测试消息。
- 测试日志位于 `/tmp/firmware-fallback-*.log`，不提交。

## 上线与本机改动备份

本机执行目录继续被 Git/Docker 忽略，不提交凭据、数据库、下载缓存或运行配置。本次本机源码、测试及 README 的差异单独保存在 [本机补丁](patches/2026-11-05-firmware-fallback-local.patch)，便于随 Git 记录恢复；补丁已反向 dry-run 核对，与实际改动一致。

先更新并重启本机下载服务，再将此提交推到 `feature/vps-native-deploy`；VPS `/opt/ProductExpertCloud` 使用 `git pull --ff-only`，构建并重启 `product-expert.service`。Bridge 协议及代码没有变化，原隧道和环境变量继续使用，无新依赖。

本机补丁仅供还原旧本机版本时使用，不在 VPS 应用，也不要向已更新的本机重复应用。
