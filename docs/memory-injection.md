# Memory Injection

管理员登录后，侧栏Synchronize上方的Memory Injection打开单个对话框。输入自然语言新增、更正或删除主记忆，点击Generate preview；AI判断ADD/UPDATE/DELETE并整理正文。意图或匹配条目不明确时显示问题，修改输入后重新预览，不能确认含疑问的修改。英文控件，模型说明按输入语言生成。

预览逐条展示操作、精确ID、理由及修改前后完整条目。只有点击Confirm injection才更新`.data/memory/urovo-product-expert/MEMORY.md`。修改预览后的输入会隐藏确认按钮。普通聊天memory工具继续只写同目录MEMORY_EXTRA.md，WeCom/MCP凭证不能使用管理员接口。主记忆和额外记忆仍每轮分别注入；UMS无新记忆逻辑。

## 模型与保存

- 独立Pi会话共用.env的MODEL_ID/BASE_URL/API_KEY、上下文/输出上限及全局思考强度；只提供提交预览的内部工具，没有文件/联网/记忆写工具，不加载普通Skill或额外记忆。
- 一次最多30条操作、每条正文64000字符、输入16000字符。主记忆最多2MiB，超限报错，不截断。单次后台操作3分钟，最多8次模型请求，使用现有全局模型并发额度。
- 延续现有`# Skill Memories`、`## Memory mem_…`格式。新增ID和元数据由后台生成，邮箱unknown@email.com；更新保留ID、创建时间和作者，只更新内容/类型及更新时间；删除只移除指定条目；未涉及条目保留原文。正文标题提示从###起步。
- 预览30分钟有效，绑定整个文件的哈希，确认时重新读取；文件发生变化或预览过期，必须重新生成。确认只接受预览ID，不接受客户端传来的正文、路径或操作列表。
- 确认取得与问答/Synchronize共用的知识写锁，等待已开始的问答完成后校验、备份并原子替换，下一轮读取新记忆。拒绝路径符号链接/硬链接、坏格式及重复目标，不触碰SKILL/UMS/MEMORY_EXTRA。
- 预览和确认返回202，页面轮询状态。关闭对话框不取消任务，重新打开可继续；同浏览器刷新后用sessionStorage中保存的预览ID恢复。后台一时只执行一个主记忆操作。
- `.data/memory-injection/<id>.json`保留请求、模型用量、预览和确认记录；备份在`.data/maintenance-backups/main-memory/<id>.md`，不随聊天30天清理。预览不会写主记忆。重启后未完成预览标记失败；发布中断根据保存的前后哈希恢复状态，已经发布的确认重复调用不重复新增。

格式异常或缺失的主记忆不会被此入口擅自初始化；先恢复主记忆文件。服务重启/取消/模型失败保留当前文件；本机模拟接口的验证不代表真实模型判断准确率。

## 管理员API

沿用登录Cookie、Origin和X-Local-Token校验，机器凭证无维护权限：

| 方法 | 路径 | 内容 |
|---|---|---|
| POST | `/api/memory-injection/previews` | 仅`{prompt}`；202返回预览ID |
| GET | `/api/memory-injection/previews/<id>` | 状态、问题、逐条前后对比及已记录用量 |
| POST | `/api/memory-injection/previews/<id>/confirm` | 空对象`{}`；202后轮询直至committed/conflict/failed |

## 已完成记忆目录迁移的VPS升级

不需要改.env、安装依赖、迁移记忆或增加service。提交/推送本地代码后，VPS按原流程停服务、拉代码、npm test（包含构建）。还必须打开实际unit：

```sh
systemctl edit --full product-expert.service
```

**删除这行**（若存在）：

```ini
ReadOnlyPaths=-/opt/ProductExpertCloud/.data/memory/urovo-product-expert/MEMORY.md
```

保留ReadWritePaths对.data的开放、当前root/专用账号以及SKILL/SYNC_PROMPT/UMS/file-runtime保护；不要把整个memory父目录设成只读。服务账号仍须能写主记忆所在目录，以便原子替换。

```sh
systemctl daemon-reload
systemctl start product-expert.service
systemctl status product-expert.service --no-pager
```

首次验证可用一条无关业务的测试记忆：Generate preview确认文件未变，再Confirm injection确认主记忆新增且额外记忆未变，最后预览并确认删除测试条目。实际Cloud记忆为准，不从Mac覆盖。
