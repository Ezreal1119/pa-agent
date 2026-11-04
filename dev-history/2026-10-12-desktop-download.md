# 2026-10-12：桌面大文件下载修复

## 证据与边界

用户截图显示约60MB文件保存失败和通用离线提示。云端只读检查：SQ610 Excel实际68,334,073字节，文件存在；若干artifact GET的Nginx响应正文只发送42–44MB，部分任务JSON也被提前断开。原源码两个完整任务GET各20秒，下载整个fetch/body120秒。日志未记录request_time，超时为高度吻合原因，未断言所有失败均同一根因；服务有更新停机期间的登录502，与此前大文件失败不混为一谈。

本轮只修改pi-patrick；未上传、重启或写入云端，不修改patrick-agent、Library、模型/缓存/评分规则或旧Excel。

## 实现

- ui-server：同一产物路由新增HEAD，鉴权/归属/Host/路径保护不变，无正文、不打开文件流；GET旧行为兼容，连接关闭销毁读流。
- backend：一次HEAD取Content-Disposition文件名，主进程保存阶段复用元信息，不再两次获取完整任务JSON；只允许固定任务/索引路由和xlsx/json。新版需先更新后端；405明确提示版本顺序。
- 普通JSON/元信息请求60秒；下载独立AbortController，60秒没有数据中断、总时限30分钟；数据块刷新idle，数据持续流动不受旧120秒限制。内部时限注入只用于测试，renderer无设置权。
- Transform流量计数，最多约每250ms通过固定IPC事件发送id/index/received/total/state；renderer显示MB/百分比/校验阶段，不获得任意网络/文件系统/令牌访问。
- 同一文件主进程保存互斥；会话代数保护对话框跨登录，登录/注销/窗口关闭取消活动下载。后台生成不受影响。
- 保留MIME/字节长度/JSON或PK检查、同目录随机partial和最后rename；失败清理，保留已存在目标。超时/断流/保存/响应格式单独错误，不误称服务离线。没有引入自动重试、断点续传或新依赖。

## 验证与交付

- npm run typecheck、npm run build：通过。
- npm test：171项全部通过。
- desktop定向13项通过，含新9项：64MiB合成文件原字节SHA-256、慢流超过普通超时、单次HEAD无任务GET、进度、空闲/总时限、断流、会话取消、固定路由与本地写失败。测试用缩短时限，不冒称真实30分钟慢网或Windows验证。
- 客户端后端定向4项通过，补充HEAD未登录/他人任务/无正文/头部/JSON/原GET/外部符号链接拒绝。
- 桌面版本从用户已设置的0.1.1升到0.1.2；Mac云端ZIP和Windows纯桌面源码包单独交付，Windows安装包需在用户Windows构建。
- 不自动覆盖用户安装应用，不部署云端。需后端先更新、安装新版，再用已有约65MiB Excel实机测试。

交付复核：Mac打包命令成功，asar元数据0.1.2/http://8.133.254.83，内含HEAD和30分钟新链路，无.env/.data/node_modules。Windows源码ZIP56,638字节，只含桌面源码/锁文件/配置/测试/说明。后端现有测试另增加真实BackendClient与临时Library服务的HEAD→GET→保存联通断言，无模型调用。
