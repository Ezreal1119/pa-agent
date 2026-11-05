/**
 * 录入器自检：造一个临时 Library，用 editor-library 写两道工序，
 * 再用对方真实的 build-ckd-catalog-v3 扫一遍，确认它们被正确识别。
 *
 * 运行：npx tsx tools/editor-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProject, saveProcess, listProcesses, readProcess, listProjects, deleteProcess, reorderProcesses } from "../src/ckd/editor-library.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** 允许从临时编译目录运行时指回仓库根（SOP_REPO_ROOT），否则按 tools/ 的上一级推算。 */
const repo = process.env.SOP_REPO_ROOT ?? path.resolve(here, "..");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败：${message}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sop-editor-"));
const library = path.join(root, "ckd-library-v2");
fs.mkdirSync(path.join(library, "product_lib"), { recursive: true });
fs.mkdirSync(path.join(library, "processes_lib", "assemble"), { recursive: true });
console.log("临时库:", library);

// 1) 建项目
const project = createProject(library, { projectId: "SQ69BXP", displayName: "SQ69BXP 整机组装" });
assert(project.projectId === "SQ69BXP", "项目应创建成功");
assert(listProjects(library).length === 1, "项目列表应有 1 个");

// 2) 第一道工序：4 张图 + 4 段说明
const first = saveProcess(library, {
  projectId: "SQ69BXP",
  language: "中文",
  order: 1,
  metadata: "前加工1-上料",
  bom: [
    { partno: "PN-001", spec: "外壳", qty: 1 },
    { partno: "PN-002", spec: "螺丝 M2x4", qty: 4 }
  ],
  tools: [{ name: "电批", specs: "0.35kgf·cm" }],
  paragraphs: ["取外壳放入治具。", "电批锁附 4 颗螺丝。", "确认无浮高。", "放入流水线。"],
  photos: [PNG, PNG, PNG, PNG].map(dataUrl => ({ dataUrl })),
  selfCheck: "螺丝是否全部锁附到位？",
  previousStationCheck: "上一道来料是否齐全？",
  hours: 35,
  manpower: 2
});
assert(first.folder === "process_01", `文件夹名应为 process_01，实际 ${first.folder}`);
assert(first.warnings.length === 0, `第一道不应有警告，实际：${first.warnings.join(" / ")}`);

// 3) 第二道工序：2 张图
saveProcess(library, {
  projectId: "SQ69BXP",
  language: "中文",
  order: 2,
  metadata: "前加工2-点胶",
  bom: [{ partno: "PN-003", spec: "胶水", qty: 1 }],
  tools: [{ name: "点胶机", specs: "0.02ml" }],
  paragraphs: ["沿边缘点胶一周。", "静置 30 秒。"],
  photos: [PNG, PNG].map(dataUrl => ({ dataUrl })),
  selfCheck: "胶量是否均匀？",
  hours: 42
});

// 4) 落盘结构
const processRoot = path.join(library, "product_lib", "SQ69BXP", "assemble", "CN_process", "process_01");
console.log("\n== process_01 目录");
for (const entry of fs.readdirSync(processRoot, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    console.log(`  ${entry.name}/`, fs.readdirSync(path.join(processRoot, entry.name)).join(", "));
  } else {
    const content = fs.readFileSync(path.join(processRoot, entry.name), "utf8").trim();
    console.log(`  ${entry.name}: ${content.length > 60 ? `${content.slice(0, 60)}…` : content}`);
  }
}

// 5) 读回校验
const record = readProcess(library, { projectId: "SQ69BXP", language: "中文", order: 1 });
assert(record.metadata === "前加工1-上料", "metadata 应读回工序名");
assert(record.bom.length === 2 && record.bom[1]!.partno === "PN-002", "物料应读回 2 行");
assert(record.paragraphs.length === 4, `应读回 4 段步骤，实际 ${record.paragraphs.length}`);
assert(record.photos.length === 4, "应读回 4 张图");
assert(record.hours === 35 && record.manpower === 2, "工时人力应读回");
const processes = listProcesses(library, { projectId: "SQ69BXP", language: "中文" });
assert(processes.length === 2 && processes[0]!.folder === "process_01", "工序列表应有序");

// 5.1) sops.json 应自动补上 processSequence
const sopsFile = path.join(library, "product_lib", "SQ69BXP", "assemble", "sops.json");
const readSops = () => JSON.parse(fs.readFileSync(sopsFile, "utf8"));
assert(fs.existsSync(sopsFile), "保存工序后应生成 assemble/sops.json");
assert(JSON.stringify(readSops().sops[0].processSequence) === JSON.stringify(["process_01", "process_02"]),
  `processSequence 应为 01,02，实际 ${JSON.stringify(readSops().sops[0].processSequence)}`);

// 5.2) 新建再删除，sequence 不能留悬空条目
saveProcess(library, { projectId: "SQ69BXP", language: "中文", order: 3, metadata: "临时工序", paragraphs: ["占位"], photos: [{ dataUrl: PNG }] });
assert(readSops().sops[0].processSequence.includes("process_03"), "第 3 道应追加进 sequence");
deleteProcess(library, { projectId: "SQ69BXP", language: "中文", order: 3 });
assert(!readSops().sops[0].processSequence.includes("process_03"), "删除后 sequence 不应残留 process_03");

// 5.3) 重排后 sequence 跟随新顺序
reorderProcesses(library, { projectId: "SQ69BXP", language: "中文", folders: ["process_02", "process_01"] });
assert(JSON.stringify(readSops().sops[0].processSequence) === JSON.stringify(["process_01", "process_02"]),
  `重排后 sequence 应为 01,02，实际 ${JSON.stringify(readSops().sops[0].processSequence)}`);
const afterReorder = readProcess(library, { projectId: "SQ69BXP", language: "中文", order: 1 });
assert(afterReorder.metadata === "前加工2-点胶", `重排后 process_01 应是原第 2 道，实际 ${afterReorder.metadata}`);
// 换回来，后面 catalog 断言按原顺序
reorderProcesses(library, { projectId: "SQ69BXP", language: "中文", folders: ["process_02", "process_01"] });

// 6) 数量不一致必须被拦住
let rejected = false;
try {
  saveProcess(library, {
    projectId: "SQ69BXP", language: "中文", order: 3, metadata: "测试",
    paragraphs: ["一", "二", "三"], photos: [{ dataUrl: PNG }]
  });
} catch (error) {
  rejected = /数量不一致/u.test(String(error));
}
assert(rejected, "图 1 张、步骤 3 段的请求必须被拒绝");

// 7) 用对方的 catalog 脚本扫一遍
const workspace = path.join(root, "workspace", "run-1");
fs.mkdirSync(workspace, { recursive: true });
const inputFile = path.join(root, "catalog-input.json");
const outputFile = path.join(root, "catalog-output.json");
fs.writeFileSync(inputFile, JSON.stringify({
  inputs: { sopType: "assemble", templateLanguage: "中文" },
  paths: { libraryRoots: [root], sessionWorkspace: workspace, workspaceRoot: path.join(root, "workspace") }
}, null, 2));
const catalogScript = path.join(repo, "resources", "workflows", "create-ckd-sop", "build-ckd-catalog-v3", "index.cjs");
const run = spawnSync(process.execPath, [catalogScript, "--input", inputFile, "--output", outputFile], { encoding: "utf8" });
if (run.status !== 0) {
  console.error("catalog 失败:", run.stderr || run.stdout);
  process.exit(1);
}
const output = JSON.parse(fs.readFileSync(outputFile, "utf8"));
console.log("\n== catalog 结果");
console.log("  摘要:", output.summary);
console.log("  警告:", output.output.warnings.length ? output.output.warnings : "无");
const catalog = JSON.parse(fs.readFileSync(path.join(root, "workspace", output.output.catalogPath), "utf8"));
const catalogProcesses = catalog.processes ?? [];
console.log("  工序顺序:", catalogProcesses.map((item: any) => `${item.processId}=${item.displayName}`).join(" → "));
assert(catalogProcesses.length === 2, `catalog 应识别 2 道工序，实际 ${catalogProcesses.length}`);
assert(catalogProcesses[0].displayName === "前加工1-上料", "第 1 道显示名应为 metadata 内容");
assert(catalogProcesses[1].displayName === "前加工2-点胶", "第 2 道显示名应为 metadata 内容");
assert(/1 SOP definition/u.test(String(output.summary)), `catalog 应识别到 1 个 SOP 定义，实际：${output.summary}`);

console.log("\n全部通过。临时目录：", root);
