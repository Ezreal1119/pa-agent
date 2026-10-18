# 2026-10-18 产品Markdown同步脚本

用户指定路径.data/product_docs_sync.py，脚本和运行数据保持Git忽略。默认源/目标从脚本所在项目推导，当前分别是/Users/patrickxu/patrick-agent/skills/urovo-product-expert与/Users/patrickxu/ProductExpertCloud/.data/urovo-product-expert。源技能目录三个受保护文件按文件名在所有深度排除；独立MEMORY源为patrick-agent/skill_memories/urovo-product-expert/MEMORY.md。目标已有SKILL/SYNC不改，保留额外文件；共享memory与UMS均不触达。

使用：python3 .data/product_docs_sync.py --dry-run预览，去掉--dry-run才写入。脚本可覆盖三个路径便于迁移及隔离验证；逐文件原子更新、覆盖前备份、同目标父目录flock互斥，拒绝源目录重叠/符号链接/硬链接文件/空MEMORY。发生中途IO失败时前面已更新文件不会整体自动回滚，旧版本保存在maintenance-backups/product-docs-sync，不能当作全批事务承诺。

已用临时夹具执行真实同步验证上述规则，反复执行无变更；真实业务目录仅预览，491篇文档一致，仅独立MEMORY需要更新。没有实际覆盖业务MEMORY。验证日志在.data/debug/product-docs-sync，未修改或运行patrick-agent，不涉及VPS。.data脚本不会随git push/pull同步，需单独保留或传输。
