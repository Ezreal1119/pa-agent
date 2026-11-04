# CKD 协作开发

## 获取代码

```bash
git clone --branch create-ckd-sop https://github.com/Ezreal1119/pa-agent.git ckd-sop
cd ckd-sop
npm ci
```

需要仓库访问权限。使用 Node.js 22.19.0 或更高版本、Python 3.11 或更高版本；Node 依赖由根目录 `package-lock.json` 锁定。桌面端有独立依赖和锁文件，后端开发不需要安装 Electron。项目可独立构建，不需要 `patrick-agent` 或 `pi-agent` 仓库。

## 验证代码

像素评分和部分回归测试需要 Python 以及固定版本的 NumPy/Pillow。使用独立环境，避免修改系统 Python：

```bash
python3 -m venv .venv-scoring
.venv-scoring/bin/python -m pip install -r resources/image-quality/v1.23.0/requirements.txt
export CKD_SCORER_PYTHON="$PWD/.venv-scoring/bin/python"
npm run typecheck
npm run build
npm test
```

Windows PowerShell 使用 `.venv-scoring\Scripts\python.exe`，环境变量改为 `$env:CKD_SCORER_PYTHON = "$PWD\.venv-scoring\Scripts\python.exe"`；其余 npm 命令相同。

这些自动测试自行生成临时 Library、图片和任务，并使用模拟模型；不需要生产 Library、真实密钥或服务器连接。客户原始样图及大图的专用验收不在 Git 内，不能用普通单元测试代替客户样例验收。像素评分的完整参考对照工具见 `tests/pixel_v123_verify.py`，其私有样例需另行授权提供。

## 本地运行

```bash
cp .env.example .env
```

按 `.env.example` 配置自己的文字模型；独立工序重点检查和图片描述还需要自己的 `VISION_*` 模型配置。生产密码和密钥不得复制到源码、测试或 PR。

真实 SOP 生成需要经授权单独取得 Library。将 `CKD_LIBRARY` 设置为你自己的 `ckd-library-v2` 目录，`CKD_DATA_DIR` 设置为本地数据目录，不能指向生产数据目录。缺少 Library 时仍可构建和运行上述模拟测试，但不能生成真实业务 SOP。资料结构及工作流见 [CKD 设计](docs/ckd-design.md)。

使用 V1.23.0 像素评分时，在本地 `.env` 配置：

```dotenv
CKD_IMAGE_SCORER=pixel-v1.23.0
CKD_SCORER_PYTHON=/absolute/path/to/.venv-scoring/bin/python
```

然后运行：

```bash
npm run ckd:ui
```

终端会显示本地地址，默认 `http://127.0.0.1:4317`。数值像素评分不调用 AI；独立工序重点检查、翻译和描述仍可能调用模型。历史评分实现保留用于旧任务恢复，单独修改本地 `.env` 不会改动其他人的配置。

桌面端开发：

```bash
npm run desktop:install
npm run desktop:start
```

`desktop/config.json` 默认连接本机后端。云端打包配置见 `desktop/electron-builder.cloud.cjs`；普通开发和自动测试不需要连接 VPS，构建安装包不代表已经在目标系统完成运行验证。

## 提交与合并

```bash
git switch create-ckd-sop
git pull --ff-only
git switch -c codex/your-change
# 修改、验证后，明确选择本次相关文件。
git add src/your-file.ts tests/your-test.test.ts
git diff --cached --stat
git diff --cached
git commit -m "fix: describe the change"
git push -u origin codex/your-change
```

在 GitHub 创建 PR，目标分支选择 **`create-ckd-sop`**。说明行为变化、验证结果和兼容性影响。暂不改变远程默认分支，不直接合并到 `main`，不强制推送协作分支。

遵守 [AGENTS.md](AGENTS.md)：修改工作流、接口或运行配置时更新 [Core 变更记录](docs/core-changelog.md) 和相应 `dev-history/` 记录；不要运行其他仓库的文档生成器。

## Git 与业务文件的边界

- 提交：源码、测试、锁文件、通用配置示例、固定评分程序/配置、生成 Excel 所需的空模板和 Logo、开发说明。
- 单独管理：真实 Library、业务图片和 Excel、任务与缓存、实际评分参考图、密钥及 `.env`、日志、备份、安装包、业务文件路径/Hash 清单。
- `.gitignore` 是第一道保护；提交前仍须检查暂存区。不要使用 `git add -f` 绕过业务文件和凭据的忽略规则。
- `.gitattributes` 保留参考评分程序和配置的原始换行与字节；不要让编辑器自动格式化这些文件，否则会改变其 Hash。
- 代码推送不会部署 VPS，也不会执行整库同步。部署另见 [VPS 部署说明](docs/vps-deployment.md)，上线前独立验证和备份。
