# Windows Tools Agent

Supervisor 通过 `ask_windows_tools_agent` 委派 PCTool 和 SNTool 的静态排障。子 Agent 使用独立的只读工具 `read`、`grep`、`find` 和 `ls`。每次委派从独立会话开始，接收当前问题和 Supervisor 提取的相关背景。

Supervisor 每轮最多调用 50 次工具，达到上限后根据已有结果回答。Windows Tools 每次委派最多 180 秒、50 次工具调用和 50 次模型请求。达到工具额度或只剩最后一次模型请求时，子 Agent 使用已有资料作答。

Web 和企微的已上传文本附件可以通过 `ask_windows_tools_agent` 的可选参数 `attachment_ids` 委派。Supervisor 从会话里的附件元数据取 ID，子 Agent 用 `attachment:<id>` 搜索和分段读取原件。访问权限限于本次显式委派的附件。

子 Agent 用普通文字说明可能的问题、判断原因和仍缺的信息。Supervisor 可以结合对话和子 Agent 的诊断继续分析，组织自己的回答。已截断的输出以部分分析交回。

## 上传 workspace

在 Mac 执行下面的命令。源码通过 Git 部署，完整快照存放在 VPS 的应用数据目录。

```bash
ssh aliyun 'mkdir -p /opt/ProductExpertCloud/.data/windows-tools/workspace'
rsync -ah --partial --progress --no-owner --no-group \
  '/Users/patrick/Tool-Diagnostics-Corpus/Pi-workspace/' \
  'aliyun:/opt/ProductExpertCloud/.data/windows-tools/workspace/'
```

保留源路径末尾的斜杠。上传后，`PCTool/README.md` 和 `SNTool/README.md` 都应在目标 workspace 下。如果生产环境使用了不同的 `AGENT_DATA_DIR`，上传到该数据目录下的 `windows-tools/workspace`。运行后端的账户应能读取快照。检索复用项目已有的 `rg`。

## 部署并开启

提交和推送代码后，在 VPS 的应用目录拉取当前分支并重新构建。

```bash
cd /opt/ProductExpertCloud &&
sudo chown -R "$(systemctl show --property=User --value product-expert.service)" /opt/ProductExpertCloud/.data/windows-tools &&
git pull --ff-only &&
npm run build &&
sudo systemctl restart product-expert.service wecom-bridge.service
```

打开管理界面的 **Sub-Agents → Windows Tools Agent** 并开启。开关默认关闭，上传路径通过启动时的 workspace 检查后才能启用。让 Agent 解释一条已知报错并要求给出快照中的文件和行号，检查工具详情里有 `ask_windows_tools_agent`。

启用后，已有主问答入口的调用方可通过 Supervisor 使用该 Agent。模型请求包含任务背景及本轮查到的相关片段。System Prompt 由项目管理，位于 `resources/agents/windows-tools/system.md`。
