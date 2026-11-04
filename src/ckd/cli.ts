import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { CkdWorkflow } from "./service.js";
import type { CkdRun } from "./types.js";
import type { CreateCkdSopGraphInput } from "./contract.js";

const help = `Usage: npm run ckd -- <command> [options]
  start --input input.json [--library /path/ckd-library-v2]
  get <task-id>
  list
  answer <task-id> --question <question-id> --text <answer>
  resume <task-id>
  cancel <task-id>
Options: --data-dir <directory> --json --non-interactive
Use npm run --silent ckd -- ... --json for clean machine-readable stdout.`;
async function main() {
  const args = process.argv.slice(2); const command = args.shift();
  if (!command || command === "help" || command === "--help") { console.log(help); return; }
  const options: Record<string, string | boolean> = {}; const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith("--")) { positional.push(value); continue; }
    if (!["--input", "--library", "--data-dir", "--question", "--text", "--json", "--non-interactive"].includes(value)) throw new Error(`Unknown option ${value}`);
    if (value === "--json" || value === "--non-interactive") options[value] = true;
    else { const next = args[++index]; if (next === undefined) throw new Error(`Missing value for ${value}`); options[value] = next; }
  }
  const option = (key: string): string | undefined => typeof options[key] === "string" ? options[key] as string : undefined;
  const required = (key: string): string => { const value = option(key); if (!value) throw new Error(`${key} is required`); return value; };
  const service = new CkdWorkflow({ dataDir: option("--data-dir"), libraryPath: option("--library"), onEvent: event => console.error(`[${event.runId}] ${event.message}`) });
  const id = positional[0];
  if (command !== "start" && command !== "list" && !id) throw new Error("Task ID is required.");
  let result: CkdRun | CkdRun[];
  switch (command) {
    case "start": result = await service.start(JSON.parse(fs.readFileSync(path.resolve(required("--input")), "utf8")) as CreateCkdSopGraphInput); break;
    case "get": result = service.get(id!); break;
    case "list": result = service.list(); break;
    case "answer": result = await service.answer(id!, required("--question"), required("--text")); break;
    case "resume": result = await service.resume(id!); break;
    case "cancel": result = await service.cancel(id!); break;
    default: throw new Error(`Unknown command ${command}\n${help}`);
  }
  if (!Array.isArray(result) && ["start", "answer", "resume"].includes(command) && process.stdin.isTTY && process.stderr.isTTY && !options["--non-interactive"] && !options["--json"]) {
    const reader = createInterface({ input: process.stdin, output: process.stderr });
    try {
      while (result.pendingQuestion && result.status === "awaiting_clarification") {
        const q = result.pendingQuestion;
        console.error(`\n${q.question}`); q.options.forEach((item, index) => console.error(`${index + 1}. ${item}`));
        let text = (await reader.question("> ")).trim(); const number = Number(text);
        if (/^\d+$/u.test(text) && number >= 1 && number <= q.options.length) text = q.options[number - 1]!;
        try { result = await service.answer(result.id, q.id, text); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
      }
    } finally { reader.close(); }
  }
  if (options["--json"]) console.log(JSON.stringify(result, null, 2));
  else if (Array.isArray(result)) result.forEach(item => console.log(`${item.id}\t${item.status}\t${item.inputs.projectName}`));
  else {
    console.log(`Task: ${result.id}\nStatus: ${result.status}`);
    if (result.pendingQuestion) console.log(`Question: ${result.pendingQuestion.id}\n${result.pendingQuestion.question}\n${result.pendingQuestion.options.join("\n")}`);
    if (result.finalResult) {
      for (const file of result.finalResult.artifacts) console.log(path.resolve(result.workspaceRoot, file));
      const output = result.finalResult.output as Record<string, any>;
      if (output.reviewSummary) console.log(`工序评分：${output.reviewSummary.overallScore}/100`);
      const quality = output.imageQuality;
      if (quality) console.log(`图片质量评分：${quality.overallScore === null ? "未评分" : `${quality.overallScore}/100`}；共 ${quality.totalImages} 张，已评分 ${quality.scoredUniqueImages} 张不同图片，${quality.reminderCount ?? 0} 张触发 ${quality.alertThreshold ?? 80} 分警告阈值，失败 ${quality.errorCount} 张，待确认 ${quality.needsReviewCount} 张。`);
    }
    if (result.error) console.error(result.error);
  }
  if (!Array.isArray(result) && ["failed", "terminated"].includes(result.status)) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
