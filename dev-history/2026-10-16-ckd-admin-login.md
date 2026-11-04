# 云端 Web 管理员登录

原因：开放管理员 Web 入口前，原本仅依赖本机 Host/Origin 的界面和管理 API 需要独立身份验证，避免与桌面用户账号混用。

实现：新增带随机盐的 scrypt 密码校验、12 小时内存 Cookie 会话、退出登录和登录失败限流。`/admin/` 代理前缀覆盖页面、静态资源、管理 API、图片和文件下载；`/api/client/` 仍走原 Bearer 登录。生产启动要求管理员账号、密码哈希和 Origin。仓库 Nginx 模板增加管理员路径，实际 Nginx 留给用户配置。

验证：`npm run typecheck`、`npm run build`、管理员与桌面/旧 Web 相关测试、完整测试。部署后再验证服务器本机未登录 401、桌面接口不受影响；公网入口待 Nginx 配置后验证。
