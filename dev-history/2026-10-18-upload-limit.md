# 2026-10-18 单文件30MiB限制

用户要求上传10M改30M；ProductExpertCloud默认与.env.example均改31457280字节。Web已由/api/status.fileTools.maxFileBytes动态驱动显示/客户端校验，因此不改界面布局。FileStore原流式和header限制沿用；Excel/图片输入中的20MiB/12MiB常量改成workerScope配置，Excel输出也统一。大图仍需像素与视觉请求限制，Office仍有解压与单元格限制，未扩大其他资源预算。

新增2项测试：HTTP边界/超一字节/流式溢出/状态值；实际worker21MiB以上Excel读写和13MiB图片识别（模拟视觉服务）。81项完整测试通过；移除最后一处未使用旧常量后另作构建。日志.data/debug/upload-limit，测试夹具在临时目录自动清理。无真实API或VPS操作，未改业务资料/.env，不涉及源patrick-agent/pi-patrick。

同步：提交推送代码，VPS拉取构建测试；已有.env的FILE_MAX_BYTES=10485760必须手工改成31457280，Git不会更新.env。重启product-expert使设置生效。无需重装依赖。
