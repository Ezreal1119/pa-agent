# 2026-10-18 无 Docker VPS 适配

用户已将 feature/vps-native-deploy 和两个完整知识目录复制到 /opt/ProductExpertCloud；反馈 Ubuntu24 x86_64、Node22.23.2、Python3.12.3、约1.6GiB内存/2GiB swap，MarkItDown --help 成功，.env 手工配置完成。本轮只修改 Mac 的 ProductExpertCloud；没有 SSH 或修改 VPS，不涉及 patrick-agent/pi-patrick。

取消 Linux production 强制容器，空镜像沿用原生子进程；工作目录收窄到 job。配置仍由 FILE_WORKER_IMAGE 决定，保留容器兼容和原来文件工具保护。新增 systemd unit、原生部署说明以及文档修正。知识目录只读与资源总额依赖 unit，手工 node 启动没有这些 systemd 保护；worker 同账号可读取的文件和网络不构成每任务沙箱。服务 OOM 可能中断整组运行，不能宣称已保证24小时不间断。

验证：npm test，67/67，通过；NODE_ENV=production FILE_WORKER_IMAGE= node --test tests/file-tools.test.mjs，7/7，通过，覆盖六种格式真实本机解析及模拟视觉API、超时取消、原件/公式保护、空PATH下原生production输出。git diff --check 通过。日志统一放 .data/debug/vps-native-tests.log 和 vps-native-production-tests.log。Mac测试不是Ubuntu/systemd验证；需要VPS重新构建、运行7项文件测试及验证unit实际限制/权限/重启。未运行真实模型、未修改实际.env、业务知识或记忆，也未提交/推送。
