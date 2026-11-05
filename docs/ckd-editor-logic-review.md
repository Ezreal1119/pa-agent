# 逐工序录入 · 语法与逻辑检查报告

- 检查日期：2026-11-05
- 检查对象：`D:\pa-agent\pa-agent` 分支 `qq/create-ckd-sop`（未提交的 10 个文件改动）
- 检查方式：静态阅读 + 编译 + 自检脚本 + 对真实库跑接口 + 针对可疑点写最小复现
- 结论：语法层面全部通过；逻辑层面有 **3 个会产生错误数据的缺陷**，其中 2 个在正常操作路径上就会触发。

---

## 0. 结论先说

| 级别    | 问题                                                         | 触发概率          | 后果                            |
| ----- | ---------------------------------------------------------- | ------------- | ----------------------------- |
| **高** | 保存成功后仍弹「未保存，确定切换吗」，点取消后再保存会报「图片既无内容也不是已保存的图片名」             | 几乎每次保存        | 图片提交失败，需重新上传                  |
| **高** | 一段操作步骤里带空行，读回时被拆成两段                                        | 用户敲空行时        | 打开工序丢段落；再次保存被「图 1 张、步骤 2 段」挡住 |
| **高** | 中英文共用 `sops.json` 的 `processSequence`，单语言拖拽/删除会抹掉另一语言的工序条目 | 两种语言工序数不一致时   | 另一语言的部分工序在 catalog 里「消失」，目录还在 |
| 中     | `sops.json` 的「读-改-写」发生在 Library 锁之外                        | 并发提交时         | 后写覆盖前写，丢 sequence 条目          |
| 中     | 多 SOP 项目里 `findSopsEntry` 匹配不到就新建一条，可能造出重复 SOP             | 存量库一个项目多条 SOP | catalog 出现同一个项目两条 SOP         |
| 中低    | 删除工序后自动补编号，若补编号失败会留下空号                                     | 锁冲突时          | 编号不连续，但功能可用                   |
| 中低    | 「只能 1 / 2 / 4 张图」只在前端拦截                                    | 直接调 API 时     | 写出模板没有对应版式的 3 张图              |
| 低     | DELETE 的来源校验允许无 `Origin` 通过                                | 手工构造请求        | 跨站删除的理论窗口（POST 是严格的）          |
| 低     | 工序号上限 999，前端 `max+1` 不预判                                   | 极端数据          | 保存时才报「1–999 的整数」              |
| 低     | 单请求 48 MB，单图上限 10 MiB × 12 张 = 120 MB                      | 原图直传          | 先被 413 截断，提示不如逐图校验友好          |

---

## 1. 执行过的检查

```
tsc -p tsconfig.json                                   → 0 错误
node --check resources/ckd-ui/app.js                   → OK
node --check resources/ckd-ui/editor.js                → OK
tools/editor-check.ts（含真实 build-ckd-catalog-v3）    → 全部通过
  catalog 摘要：1 project(s), 2 process(es), and 1 SOP definition(s)，警告：无
  sequence：["process_01","process_02"]，显示名按 metadata 正确
HTML 标签平衡（div/section/form/label/select/textarea） → 全部配对
JS 中 $('id') 引用的元素在 HTML 中是否存在              → 全部存在
静态资源是否随改即时生效（未重启）                      → 生效
真实库接口：建项目 / 存 2 道工序 / 回读 / 删除          → 200，验证后已清理
```

另外针对 3 个可疑点写了最小复现（见各问题下的「证据」）。

---

## 2. 文件与职责

### 后端（TypeScript）

| 文件                          | 行数  | 职责                                         |
| --------------------------- | --- | ------------------------------------------ |
| `src/ckd/editor-types.ts`   | 119 | 只管「页面上填了什么」的数据形状，不碰文件格式                    |
| `src/ckd/editor-library.ts` | 714 | 全部落盘逻辑：项目、工序目录、`sops.json`、排序、删除、读回        |
| `src/ckd/library-lock.ts`   | 74  | Library 排他锁（跨进程）+ 盘根父目录的 EPERM 修复          |
| `src/ckd/ui-server.ts`      | —   | 5 条 `/api/editor*` 路由、48 MB 请求体、来源校验、错误码映射 |

### 前端（原生 JS / HTML / CSS）

| 文件                                  | 职责                                 |
| ----------------------------------- | ---------------------------------- |
| `resources/ckd-ui/editor.html`      | 录入页骨架：左侧工序列表、顶部 SOP 基本信息、右侧表单      |
| `resources/ckd-ui/editor.js`（689 行） | 项目/工序加载、表单渲染、图片压缩、保存、拖拽排序、封面信息本地存储 |
| `resources/ckd-ui/editor.css`       | 录入页样式（含自动带出内容的弱化色）                 |
| `resources/ckd-ui/index.html`       | 工作台首页：新建 SOP 表单（已拆「匹配资料 / 封面信息」）   |
| `resources/ckd-ui/app.js`（303 行）    | 工作台逻辑 + 封面信息回落合并                   |
| `resources/ckd-ui/style.css`        | 工作台样式（新增 `.cover-divider`）         |
| `tools/editor-check.ts`             | 端到端自检：造库 → 写工序 → 真实 catalog 扫描     |



---

## 3. 主链路

### 3.1 一道工序怎么落盘

```
页面（editor.js save）
  ├ metadata / bom / tools / photos(dataUrl) / paragraphs / selfCheck / hours / manpower
  ↓ POST /api/editor/process  (48 MB 上限，必须带 X-CKD-UI: 1 + 同源 Origin)
ui-server.ts  →  saveProcess()
  ├ 1. 校验：项目名、语言、order(1–999)、工序名、物料/工具行、图片数量 ≤ 12
  ├ 2. resolvePhoto：新图走 base64 解码 + inspectImage（PNG/JPEG、≤ 10 MiB）；旧图只带文件名
  ├ 3. 硬约束：图片数 == 段落数（否则直接拒绝，避免一图对应错段）
  ├ 4. planSopsAppend()：先算出 sops.json 的新内容（格式错/超 30 道在这里就抛，不落盘）
  ├ 5. 拿 Library 锁
  ├ 6. 写到 .process_NN.<uuid>.tmp/ → 目录写全后 rename 成 process_NN
  │     已存在则先把旧目录 rename 成 .trash 再 rename，最后删 trash
  └ 7. commitSops() → 释放锁
```

### 3.2 顺序的真源是两处，必须一致

1. **文件夹名** `process_NN`：`listProcessFolders()` 用 `localeCompare` 排序，所以必须两位补零，否则 `process_10` 会排到 `process_2` 前面。
2. **`assemble/sops.json` 的 `processSequence`**：catalog 只认这个顺序。目录存在但不在 sequence 里 = 这道工序不存在。

因此录入页做了三件事（都在 `editor-library.ts`）：

| 操作   | 对 sequence 的影响                                                      |
| ---- | ------------------------------------------------------------------- |
| 保存工序 | 不在 sequence 就追加到末尾；已有则不动                                            |
| 拖拽重排 | 把 `process_NN` 那一段整体换成新顺序，非 `process_NN` 的条目保留                      |
| 删除工序 | 摘掉对应条目；sequence 空了就把整个 SOP 条目从 `sops` 数组移除（否则 catalog 报「必须 1–30 道」） |

### 3.3 catalog 怎么用这些数据

`build-ckd-catalog-v3`：

- 按 `templateLanguage` 选目录：`中文 → CN_process`，`English → processes`
- 遍历 `sops.json` 的每条 SOP，要求 `processSequence` 长度 1–30、无重复
- 若某个 ID 在当前语言目录下没有对应文件夹 → 只给 warning 并**丢弃整条 SOP**（`... is unavailable in 中文 because these Process IDs have no CN_process content`）
- 项目缺 `sops.json` → warning，该项目没有参考 SOP

### 3.4 封面信息怎么进 Excel

```
录入页「SOP 基本信息」（项目 ID / SOP 名称 / 编制人 / 审核人 / 文件编号 / 版本 / 原版本 / 日期 / 修订）
  ↓ 只存浏览器 localStorage：ckd-sop-info:<项目>，同时记 ckd-sop-info:last
工作台「封面信息」留空
  ↓ submit 时 editorSopInfo(projectName) 精确匹配该项目，空字段回填
POST /api/runs
  ↓ 后端 validateInputs 仍要求 projectName / documentNumber / sopName / author 非空
生成 Excel，写进封面单元格
```

**注意**：`审核人 / 版本 / 原版本 / 日期` 目前只存在浏览器，工作台表单没有这四个输入、后端也不接收，所以现在**进不了 Excel**。

---

## 4. 发现的问题

### P1【高】保存成功后弹「未保存」确认，取消后再保存会报错

**位置**：`resources/ckd-ui/editor.js` `save()` 第 360–370 行

```js
const result = await value.result;           // 保存已成功
state.photos = state.photos.map(...)          // 新图被改成 {kind:"keep", name:"", ...}
await openProcess(state.current);             // ← 内部第一行：if (state.dirty && !confirm(...)) return;
markClean(`已保存：${result.relativePath}`);  // ← 到这一步才 dirty=false
```

`state.dirty` 在用户编辑时被 `process-form` 的 `input` 事件置 true，保存流程从头到尾没有清零。所以 `openProcess()` 一进来就认为「有未保存改动」，弹出「当前工序有未保存的改动，确定切换吗？」。

**连锁后果**（这是最麻烦的部分）：

1. 用户点「取消」→ `openProcess` 直接 return，表单不刷新
2. 但 `state.photos` 已经被改成 `{kind:"keep", name:""}`（文件名被置空）
3. 用户再点一次保存 → `currentPhotosPayload()` 发出 `{name:""}` → 后端 `resolvePhoto` 抛出<br>
   「第 1 张图既没有上传内容，也不是已保存的图片名。」→ 图片必须重新上传

**触发条件**：改过任意字段再点保存（正常路径），confirm 里点「取消」。

**建议修法**（二选一，都只改前端）：

- `save()` 在 `openProcess()` 之前先 `state.dirty = false`；
- 或 `openProcess(order, { skipDirtyCheck: true })`，保存后的重载跳过确认。

顺带把 `state.photos` 的转换放到 `openProcess` 成功之后，避免中途失败留下空文件名。

---

### P2【高】操作步骤里的空行会破坏「一图一段」

**位置**：`editor-library.ts` `saveProcess()` 写入用空行分隔；`readProcess()` 也按空行切分

```js
// 写
fs.writeFileSync(..., `${paragraphs.join("\n\n")}\n`);
// 读
operation.split(/\n[\t ]*\n+/u).map(p => p.trim()).filter(Boolean)
```

用户在**同一段**里敲了空行（例如 `1.拿螺丝` 空一行 `2.拧紧`），写入后读回就变成两段。

**证据**（真实代码复现）：

```
写入 1 段（内含空行），读回段数 = 2 ["1.拿螺丝","2.拧紧"]
二次保存：失败 → 图片 1 张、操作步骤 2 段，数量不一致会配错文字。请每张图各写一段。
```

**后果分两级**：

1. 打开该工序时 `fillForm` 按 `paragraphs[index]` 取，多出来的段直接丢弃 → **数据显示不全**，用户保存一次就把丢掉的段永久删了
2. 若段数超过图片数，任何一次保存都会被「数量不一致」拦住，用户不知道哪里错了

**建议修法**：入库时把段内连续空行压成单个换行（`paragraph.replace(/\n{2,}/gu, "\n")`），保证「段内无空行」这个不变量成立；`readProcess` 再按空行切分才是可逆的。前端也可以在步骤文本框上提示「一段里不要空行」。

---

### P3【高】中英文共用 `sops.json`，单语言重排/删除会抹掉另一语言的工序

**位置**：`planSopsReorder()` / `planSopsDelete()`

`processSequence` 是**一个项目一份**，中英文共用。但两个语言目录的工序数可以不同（录入页只写当前语言，另一语言靠翻译任务）。

**证据**（真实代码复现）：

```
英文 4 道、中文 2 道 → sequence: [process_01, process_02, process_03, process_04]
中文页面拖拽一次后    → sequence: [process_01, process_02]
英文目录仍有: process_01,process_02,process_03,process_04
```

`planSopsReorder` 的写法是「保留前面，插入新的 `process_NN` 段，保留后面的非 `process_NN` 条目」——原来的 `process_03`、`process_04` 属于 `process_NN`，被整段丢弃了。删除也是同理：删中文的 `process_02`，英文的 `process_02` 就从 sequence 消失。

**后果**：英文目录还在，但 catalog 里那两道工序不存在了，生成英文 SOP 会缺工序。属于「看着文件在、实际用不到」的隐性丢失。

**建议修法**：

- 重排时把序号大于当前语言工序数的 `process_NN` 条目接到新顺序之后，而不是丢弃；
- 或更明确一点：重排前后对比「另一语言目录的工序数」，不一致就拒绝对 sequence 做整体改写，只改文件夹名。

这条牵涉到你们和对方对 `sops.json` 的约定，建议先确认再改。

---

### P4【中】`sops.json` 的读-改-写发生在锁外

`saveProcess()` 里 `planSopsAppend()` 在 `acquireLibraryLock()` **之前**执行：先读文件、算出新内容，拿锁后只做写入。两个请求同时进来时，都会基于同一份旧数据算，后写的覆盖先写的，丢一条 sequence。

单用户本地操作几乎不会撞上，但如果翻译同步任务或其他进程同时改 `sops.json`，就可能丢条目。

**建议修法**：把 plan 阶段挪进锁内（读+算+写在同一个锁里）。代价是校验失败时也要短暂占锁，可接受。

---

### P5【中】多 SOP 项目可能造出重复条目

```js
function findSopsEntry(document, projectId) {
  const matched = entries.find(entry => entry.sopId?.toLowerCase() === projectId.toLowerCase());
  if (matched) return matched;
  return entries.length === 1 ? entries[0] : null;   // ← 只有一条时才兜底
}
```

一个项目有多条 SOP、且没有一条 `sopId` 等于项目名时返回 `null`，`planSopsAppend` 就会新建一条 `sopId = 项目名` 的条目。catalog 允许一个项目多条 SOP，但录入页只认自己新建的那条，用户不知道另一条的存在。

**建议**：录入页在「多条 SOP 且匹配不到」时应该报错让用户明确指定，而不是静默新建。

---

### P6【中低】删除后补编号失败会留下空号

`ui-server.ts` 的 DELETE 路由：删完再调一次 `reorderProcesses` 把编号补齐。如果这次 reorder 因为锁冲突失败，删除已生效、编号没补，留下 `process_01`、`process_03`。

前端新建用 `max(order)+1`（不是 `length+1`），所以不会覆盖已有工序，只会多一个空号。功能可用，只是编号不连续。

---

### P7【中低】「只能 1 / 2 / 4 张图」只在前端拦

`editor.js` 的 `save()` 里有 `if (count === 3) 拦截`，后端 `saveProcess` 只校验「图片数 == 段落数」，没有 1/2/4 的限制。直接调 API 可以写出 3 张图的工序，而模板没有 3 张图的版式。

**建议**：把 1/2/4 的规则移到 `saveProcess` 里，前端只做提示。

---

### P8【低】DELETE 的来源校验比 POST 宽松

```js
const validPostOrigin = !request.headers.origin || (origin === expectedOrigin && x-ckd-ui === "1");
```

`POST` 走的是第 163 行的严格判断（必须带来源且匹配），`DELETE` 走 `validPostOrigin`（**没有 Origin 头就放行**）。同源策略下浏览器跨站请求都会带 Origin，实际风险很小，但两个方法用不同标准不够一致。

---

### P9【低】工序号上限没有前端预判

`validateOrder` 上限 999；前端 `openBlankProcess` 用 `max+1`，到 999 时算出 1000，只有提交后才报「工序顺序必须是 1–999 的整数」。

---

### P10【低】请求体上限与单图上限不匹配

单请求 48 MB，单图 10 MiB、最多 12 张 → 理论上限 120 MB。原图直传时会在 48 MB 处被 413 截断，提示「请减少图片数量或压缩」，不如逐图提示准确。前端已把图压到长边 1600 / JPEG 0.82（约 300 KB），正常用不到这个边界。

---

### P11【低】物料数量读回时会补 0

`readProcess` 里 `qty: finiteNumber(row.qty) ?? 0`。存量文件如果缺 `qty`，页面上会显示 0 而不是空。保存时若用户不清空，会把这个 0 写回去。属于显示层面的小偏差。

---

## 5. 已验证正常的部分

|   |   |   |
| - | - | - |

- **路径安全**：`projectId` 拒绝 `/ \ : * ? " < > |`、`.`、`..`、保留目录名；所有写入都过 `isInside()`；图片名走 `^p\d+\.(png|jpe?g)$` 白名单，且拒绝符号链接
- **原子写入**：工序目录「临时目录 + rename」，覆盖时先 rename 成 `.trash` 再换上，`sops.json` 也是临时文件 + rename
- **失败不污染**：所有内容校验都在拿锁和写目录之前完成
- **图片沿用**：改文字不必重传图片（只传文件名，后端从旧目录复制）
- **「作业前检查」带出**：取上一道工序的「自检」，弱化色显示，输入即恢复
- **拖拽排序**：两段式重命名（先全改临时名再改终名），互换不会互相覆盖
- **封面信息回落**：按项目名精确匹配 `ckd-sop-info:<项目>`，不是拿「最近一个项目」凑；空才回填，填了就覆盖；两边都空时在本地提示缺哪几项，不发请求
- **锁的 EPERM 修复**：Library 位于盘根时先判断父目录是否存在再 mkdir，`D:\CKD-agent` 实测通过
- **静态资源**：改完刷新即生效，不需要重启服务

---

## 6. 设计边界（不是 bug，但你得知道）

1. **存量命名不兼容**：录入页只认 `process_NN`，真实库里 `ass1 / qjg1 / zhijia` 那 18 道不会显示。按你的决定「不用管存量名字」，新建项目不受影响。
2. **中英文共用 `sops.json`**：只录一种语言时，另一种语言因缺目录会导致该 SOP 在 catalog 里不可用（warning，不中断构建）。靠翻译同步任务补齐。
3. **封面四个字段进不了 Excel**：审核人 / 版本 / 原版本 / 日期目前只在浏览器里，后端生成输入没有这四个字段。要用起来得让对方的生成流程加字段。
4. **`ckd-library-v2` 这一层**：catalog 的 `libraryRoots` 要求 `<库根>/ckd-library-v2/`；编辑器用的 `CKD_LIBRARY` 直接指向库本身。你本地 `D:\CKD-agent` 直接含 `product_lib`，所以只影响「本地跑 catalog」这一种情况，生产路径天然对上。
5. **nginx 12 MB**：`/admin/` 段 `client_max_body_size 12m`，前端压完 4 张约 1.2 MB，够用；超过会在 nginx 层 413，提示与服务端不一致。

---

## 7. 建议修复顺序


| 顺序 | 问题 | 工作量 | 是否要你确认 |
|---|---|---|---|
| 1 | P1 保存后误弹确认 + 空文件名 | 改 3 行（前端） | 改完行为有变化，建议先看一眼 |
| 2 | P2 段落空行压缩 | 后端 1 行 + 前端提示 | 会改变写入内容（多行步骤合并），需要你确认是否可接受 |
| 3 | P3 跨语言 sequence 保留 | 后端约 10 行 | **需要你定策略**（保留 vs 拒绝） |
| 4 | P4 锁内读改写 | 后端约 15 行 | 不改行为，只改并发安全 |
| 5 | P6 / P7 校验补齐 | 小 | 可一并做 |
| 6 | P5 / P8 / P9 / P10 / P11 | 小 | 按需 |

P1 和 P2 在正常操作路径上就会遇到，建议优先修。P3 要看你们对 `sops.json` 的约定，我等你确认后再动。

---

## 8. 当前代码状态

- 分支：`qq/create-ckd-sop`（本地），已提交 `88ff21e`，之后的 10 个文件改动**未提交**
- 推送仍 403：GitHub 凭据是 `Winkho222`，仓库属 `Ezreal1119`，需要加协作者或换凭据
- 测试服务：`http://127.0.0.1:4319`，`CKD_LIBRARY=D:\CKD-agent`
