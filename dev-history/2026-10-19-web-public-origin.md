# 2026-10-19 HTTPS 域名登录

用户访问 https://urovo-agent.patrick-shenzhen.cn/login，原始校验只允许 http://Host，与浏览器HTTPS Origin不一致，导致登录POST被拒绝。

在 ProductExpertCloud 新增 WebOriginPolicy 和 WEB_PUBLIC_URL，兼容保留公共Host与改写本机Host的TLS代理；不相信任意转发头来扩大Host/Origin范围。HTTPS登录与注销加Secure Cookie，本机调试及既有认证/CSRF不变。企微入口继续不接受公共Host/Origin，反代示例不转发该路径。

新增四项HTTP回归，模拟TLS终止后的代理请求。完整 `npm test` 104/104 通过（约18.6秒），构建和diff检查通过；日志 `.data/debug/web-public-origin/`。测试不是真实域名/证书/代理验收，没有修改 VPS、实际.env、业务知识/记忆或参考项目。用户需在VPS配置WEB_PUBLIC_URL并同步代码后单独重启product-expert.service。
