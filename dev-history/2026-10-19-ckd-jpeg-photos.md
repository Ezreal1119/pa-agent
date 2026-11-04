# JPG 图片进入 SOP Excel

## 原因与范围

SQ610 Assembly Test 的“加热台使用说明1/2”各有 `p1.jpg`，VPS 与本机原图均为 8,066,973 字节、3024×4032。Catalog、任务资料扫描和 Excel 生成器原先仅匹配 `p<number>.png`，所以这两张图片被忽略，不是文件过大。

本次将这三处命名规则统一扩展到 `.png`、`.jpg`、`.jpeg`，保留原编号排序、最多 12 张、重复编号拒绝和 PNG 行为。生成器按格式读图片尺寸，JPEG 使用 SOF 帧头；ExcelJS 的媒体类型对应 JPEG/PNG，而不是把 JPG 字节错误标成 PNG。`Previous_Station_Check_Photo.png` 与传统单图 `instruction_photos.png` 的原约定不变。图片评估本身已有 JPEG 支持，其 10 MiB、40MP、单边 20000 像素限制不变。

## 旧任务兼容

任务保存整个脚本资产树的 Hash。部署修改后，未完成旧任务按原有保护规则会拒绝继续。服务现在支持可选的 `CKD_LEGACY_RESOURCES_DIR`：当前资产 Hash 不匹配时，只在旧快照完整 Hash 与任务记录一致时使用该快照的脚本与图片扫描；否则照旧拒绝。创建新任务始终取当前资产；旧快照不被新任务选用。VPS 部署前须在资源树外复制完整旧资源并验证 Hash 一致，再设置环境变量和重启。任何旧任务在进入快照前均不改其状态或脚本 Hash。

## 验证与部署

本地回归用 3024×4032 JPEG 与 PNG 混合资料检查 Catalog、任务资料、Excel 媒体、图片锚点及重复编号拒绝；另对用户给的实际 `process/1`、`2`、`6` 只读生成临时 Excel，回读得到操作图片数量分别为 1、1、2。旧任务路由测试检查只有完整 Hash 匹配旧快照才能继续。执行 `npx tsx --test --test-timeout=30000 tests/ckd-jpeg-photos.test.ts tests/ckd-sheet-names.test.ts tests/ckd-runtime.test.ts`：24 项通过。`npm run typecheck`、`npm run build`、`npm test`、`git diff --check` 通过；完整 194 项通过、2 项平台条件跳过、0 失败。

VPS 上先把原有 21 个工作流资产完整备份到 `/opt/pi-patrick/resources/legacy/create-ckd-sop-20261019`，验证快照 Hash；再备份代码到 `/opt/pi-patrick-backups/ckd-jpeg-20261019/code-before.tar`。通过 rsync 同步本次后端与工作流改动，远端 `npm run typecheck`、`npm run build` 和 JPEG/Sheet 名定向测试均通过。systemd 设置 `CKD_LEGACY_RESOURCES_DIR` 后重启 `ckd-sop.service`；服务正常运行，Nginx 按实际 Host 访问 `/admin/login` 返回 200。只读检查 12 个未结束任务：9 个准确路由到旧快照，另 3 个在本次部署前已不匹配当时的当前资产 Hash，未更改其状态或资料。公网 IP 从本地网络测试超时，因此公网连通性未在本次验证中确认。
