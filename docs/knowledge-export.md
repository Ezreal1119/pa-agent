# 业务资料只读下载接口

为没有 VPS/SSH 权限的本地应用提供正式业务资料快照。此功能只提供服务端接口，未增加本地 HTTPS 拉取脚本、管理页面、定时任务或自动部署。

## 配置与权限

在服务端独立配置下载读者。生成一个专用随机 Token：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

将生成值填入服务端 Git 忽略的 `.env`，例如（下面是占位示例）：

```dotenv
KNOWLEDGE_EXPORT_TOKENS='[{"id":"reader-1","token":"<GENERATED_TOKEN>"}]'
```

可以配置多个 `{id, token}`，每人一条。`id` 为 1–64 个字母、数字、下划线或短横线，首字符为字母或数字；Token 为 32–256 个无空白的可打印 ASCII 字符，推荐使用上述命令生成的 64 位十六进制值。最多 100 个读者，id 和 Token 均不得重复。不要复用管理员、模型、MCP 或企微凭据。

未配置、空字符串或 `[]` 时接口关闭，返回 404。配置格式错误会在 Web 服务启动时明确报错。新增、轮换或删除读者条目后重启服务生效；删除某个条目只撤销该读者以后的请求，已下载的资料不会远程删除。

接口沿用 `WEB_PUBLIC_URL` 的 Host/Origin 策略，公开访问需配置 HTTPS 域名并经现有 HTTPS 反代访问；不新增端口或放宽跨站策略。Bearer Token 只通过 `Authorization` 请求头传递，不支持查询参数、Cookie 或管理员登录替代。下载 Token 不授予普通 Web、MCP 或企微 API 权限。

## 请求与响应

```http
GET /api/knowledge/export
Authorization: Bearer YOUR_DOWNLOAD_TOKEN
```

授权用户可用现有 HTTP 客户端下载（不需要 SSH）：

```sh
curl --fail --show-error \
  -H "Authorization: Bearer YOUR_DOWNLOAD_TOKEN" \
  https://YOUR_CLOUD_DOMAIN/api/knowledge/export \
  --output knowledge.zip
```

只支持 GET，不接受请求体、目录/文件参数、URL Token 或其他查询参数。

成功返回 `200 application/zip`，带 `Content-Length` 和附件文件名 `knowledge-<版本前16位>.zip`：

| 响应头 | 含义 |
| --- | --- |
| `X-Knowledge-Version` | 由有序文件清单及其内容摘要确定的 SHA-256 版本号 |
| `X-Knowledge-SHA256` | 本次 ZIP 完整字节的 SHA-256 |
| `ETag` | 带双引号的 ZIP SHA-256；相同快照可直接比较 |
| `Cache-Control` | `no-store`，避免代理或浏览器缓存敏感资料 |

客户端可以显式发送 `If-None-Match: "<上次ZIP的SHA-256>"`。认证通过且内容未变化时返回 304，无响应体；304 同样包含版本与校验响应头。客户端应先校验 ZIP 摘要，再按照清单校验每个解压文件；SHA-256 不代替 HTTPS 和 Token 鉴权。

## 压缩包范围

```text
knowledge-<version>.zip
├── manifest.json
├── urovo-product-expert/...
├── ums-expert/...
└── memory/urovo-product-expert/MEMORY.md
```

固定导出范围：

- `urovo-product-expert/` 内的正式 `.md` 文件，包含 SKILL/SYNC_PROMPT 等资料指引。
- 可选 `ums-expert/` 内的 `.md` 文件。UMS 目录不存在时允许省略；存在时需有非空 `SKILL.md`。
- 必需的 `memory/urovo-product-expert/MEMORY.md` 业务主记忆。

知识目录内任何层级的隐藏项、`newly_added`、旧位置 `MEMORY.md` 和 `MEMORY_EXTRA.md` 均被排除。非 Markdown 文件不在本接口范围内。主产品 `SKILL.md` 和业务主记忆必须非空。

不会扫描或打包 `.data` 下其他目录，包括会话、聊天附件、额外记忆、登录会话、任务、维护过程记录、日志、设置、备份、运行依赖和授权凭据。客户端不能指定路径或扩展范围。导出范围内的符号链接、硬链接和不安全路径会使请求失败。

清单结构如下（校验值仅示意）：

```json
{
  "formatVersion": 1,
  "version": "<file-list-sha256>",
  "createdAt": "<UTC ISO timestamp>",
  "totalFiles": 1,
  "totalBytes": 123,
  "files": [
    {"path": "urovo-product-expert/example.md", "bytes": 123, "sha256": "<file-sha256>"}
  ]
}
```

实际清单列出全部业务文件，不包含 `manifest.json` 自身。路径均相对于 ZIP 根目录，`bytes` 为 UTF-8/文件原始字节数。`createdAt` 是该快照构建时间，不是云端最后一次发布的时间。版本号是按路径升序排列的 `files` 数组经 JavaScript `JSON.stringify` 后的 SHA-256，与打包时间、文件 mtime 无关。

## 一致性与资源限制

首次请求、或正式资料变化后的请求会生成快照；未变化时复用当前进程内的 ZIP。并发请求共享一次构建，进程只保留最新压缩包缓存，不在云端写入导出文件或修改源资料。

读取快照时持有现有知识发布读锁，与 Synchronize 发布、知识编辑和主记忆编辑共用锁；不会读到这些操作发布一半的状态。生成快照期间仍允许问答读取知识。压缩和网络传输使用已取得的内存副本，不继续占用发布锁。

此锁沿用现有单进程数据目录约定。外部管理员直接写文件不参与锁，因此还会核对读取前后的文件清单、inode、大小与修改时间；发现变化就中止，不发布半成品。这不代替跨进程文件系统事务。

单文件最多 32 MiB，业务总量最多 64 MiB，最多 10000 个业务文件；另限制目录深度和遍历项数。快照构建/等待发布锁最多 30 秒，最多 4 个并行请求，每次 ZIP 传输最多 120 秒。客户端断线不会取消其他读者共用的构建。

| 状态码 | 含义 |
| --- | --- |
| 200 / 304 | 下载成功 / ZIP 未变化 |
| 400 | 包含查询参数或请求体 |
| 401 | 缺少、重复或无效的下载 Token |
| 403 | Host/Origin 不符合现有访问策略 |
| 404 | 未启用下载读者 |
| 405 | 非 GET 请求 |
| 409 | 导出期间资料发生变化，稍后重试 |
| 413 | 超出导出资源限制 |
| 429 | 已有 4 个请求在处理，按 `Retry-After` 稍后重试 |
| 503 | 必需资料缺失、路径不安全、等待超时或无法读取 |

## 验证与部署

```sh
npm run build
node --test tests/knowledge-export.test.mjs
```

无需新依赖。正式生效需管理员按既有流程更新代码、构建，配置 `KNOWLEDGE_EXPORT_TOKENS` 和 HTTPS 域名后重启 `product-expert.service`。本轮实现没有操作 VPS，也没有生成真实下载 Token。旧 SSH 拉取脚本不因本接口自动获得 HTTPS 支持。
