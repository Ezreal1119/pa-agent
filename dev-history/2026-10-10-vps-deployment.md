# 2026-10-10：Ubuntu VPS 部署

## 范围

仅 pi-patrick；patrick-agent 不改动、不运行。服务器8.133.254.83，Ubuntu24.04 x64，Node22.23.2，项目/opt/pi-patrick。本机Library、任务、客户端地址和已有后端不切换。

## 备份与迁移

完整 tar、SHA256SUMS、迁移清单/元数据原件、测试日志和原Nginx配置保存在服务器 `/opt/pi-patrick-backups/20261010-migration.X8B23p/`。备份目录700、数据tar600，.env600。

新增 deploy/migrate-data.mjs，默认预览，显式apply；拒绝锁、未完成Library事务、原始Catalog/产物损坏及计划过期。原子替换元数据、校验前后业务字节，捕获异常回滚；强杀/断电须用外部备份。仅迁移正式任务/维护任务及译文目录，不改历史归档或模型消息内容。

实际11个任务，107个元数据文件、8个脚本缓存目录，939条译文记录；4712个Library/评分缓存/校准/产物文件逐字节Hash不变。再次预览为0文件/0缓存移动。等待回答任务eec7a963-9cf2-4799-ad66-f626d09a69e0保留原问题及会话引用，没有代答。

3个已完成任务832ef5af、0340cc2c、5c31d11d的资源Hash早于当前脚本；本机也同样不匹配，不归因于Linux，不覆盖Hash。已有Excel仍可下载。

## 服务与反代

新增 ckd-sop systemd 服务，独立nologin账号，工作目录/opt/pi-patrick；编译入口dist/ckd/ui.js，只监听127.0.0.1:4317。代码root所有、依赖可读；.data由服务账号持有700，.env600。首启因npm安装时umask077导致依赖仅root可读而失败，修正node_modules/dist/resources可读权限后正常启动。

新增独立Nginx站点ckd-sop，只反代/api/client/，内部固定Host、保留鉴权及Origin；登录限流，其他路径继续原3000上游。原sites-enabled/api不修改，原主页正常。

期间为IP HTTPS安装了独立Certbot5.8并完成staging测试证书签发。用户明确要求不配置证书后，移除/opt/ckd-certbot、测试证书及ACME目录，删除未启用的TLS/续期模板，未申请正式证书、未启用443或新增续期任务。系统原Certbot2.9/已有域名证书保持原样；最终只使用http://8.133.254.83。安装的python3.12-venv为基础软件依赖，不改变既有服务。

## 验证

- 本机npm test153/153、typecheck/build及diff检查通过。
- Ubuntu npm ci/typecheck/build通过。第一次默认并行测试因两核资源竞争超时，模拟fetch没有真实socket导致unref超时信号使Node22提前结束；测试增加保活计时器，生产请求逻辑不变。串行120秒测试153/153，无取消项。
- 正式Library1136个JSON/JSONL语法检查有效，0错误。
- 本机服务器HTTP检查：未登录401、错误密码401、登录200、libraryReady=true、客户端归属任务2个、越权任务404、退出200/令牌撤销401。下载Excel14,460,689字节，与服务器文件Hash一致。
- 公网HTTP反代/api/client/status未登录401；原主页仍为Hello from my Aliyun VPS!，无443监听。证书目录/新续期服务不存在。
- Mac经公网实际登录/status/list/logout均200，下载14,460,689字节Excel与Mac原文件Hash一致；浏览器Origin403，/api/status、/api/runs、/.env及/.data路径404。
- 未运行正式任务模型、翻译、图片预分析或摘要维护；完整测试使用临时Library和可控模型。

README、docs/core-changelog.md及docs/vps-deployment.md同步说明部署边界、仅代码更新、服务权限和数据恢复。Windows包/桌面远程地址切换后续单独完成。
