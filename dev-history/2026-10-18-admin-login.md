# Web 管理员登录

用户要求 ADMIN_ACCOUNT、ADMIN_PASSWORD 登录配置。

- `.env.example` 与实际忽略的 `.env` 增加字段；本机仅追加缺少的空值，不设置默认凭据、不修改模型配置，文件权限 600。
- `src/web/auth.ts` 管理单管理员认证、随机 Cookie 令牌摘要、固定 12 小时到期、128 个登录上限和失败限流。状态在内存中，重启失效。
- `server.ts` 在所有 Agent/会话/配置接口前校验登录；登录页面和必要静态资源开放，auth/status 提供非敏感 bootstrap 与本地 Token。保留原请求 Token、Host/Origin 检查。
- 新增 login.html/login.js，与现有界面样式一致。主界面可退出，登录失效时返回登录页。密码不进入 localStorage、URL、会话文件或 API 响应。
- 35 项本地测试通过；隔离浏览器验证错误登录、成功登录、刷新与退出。没有真实模型调用，用户实际账号密码留待其填写。

API 调用方式变化：先 GET auth/status，携带 Token POST auth/login，之后携带 Cookie 与原 Token 使用会话接口。当前仍仅监听本机，没有开放外部网络或新增角色权限。
