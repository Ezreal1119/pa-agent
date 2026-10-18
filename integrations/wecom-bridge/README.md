# Product Expert WeCom Bridge

独立企微长连接进程，通过本机专用 API 复用 Product Agent。配置、VPS 安装、会话规则、并发和恢复说明见 [接入文档](../../docs/wecom-bridge.md)。

在项目根目录安装依赖后：

```bash
npm run wecom:bridge
npm run test:wecom
```

默认 `WECOM_ENABLED=false`，不会连接企微。状态位于项目 `.data/wecom/`，凭据只放项目 `.env`。
