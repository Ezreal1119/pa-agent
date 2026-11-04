import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CREATE_CKD_SOP_SCRIPT_NAMES } from "./contract.js";
import type { GraphScriptExecutionRequest } from "./definition.js";
import type { CkdRun, WorkflowStepSubmission } from "./types.js";
import { atomicJson, isInside } from "./store.js";
import { validate } from "./validation.js";

export const defaultResources = fileURLToPath(new URL("../../resources/workflows/create-ckd-sop/", import.meta.url));
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function assetHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Workflow assets cannot contain symlinks: ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) hashes[path.relative(root, file)] = sha256(fs.readFileSync(file));
    }
  };
  visit(root); return hashes;
}
export function verifyAssets(run: CkdRun, root: string): void {
  if (JSON.stringify(assetHashes(root)) !== JSON.stringify(run.scriptHashes)) throw new Error("Workflow assets changed since this task started. Start a new task.");
}
function artifactHashes(run: CkdRun, result: WorkflowStepSubmission): Record<string, string> {
  const files = [...result.artifacts];
  const output = result.output as Record<string, unknown>;
  if (Array.isArray(output?.effectiveFiles)) for (const file of output.effectiveFiles) {
    if (file && typeof file.relativePath === "string") files.push(file.relativePath);
  }
  if (typeof output?.catalogPath === "string") files.push(output.catalogPath);
  const hashes: Record<string, string> = {};
  const workspace = path.resolve(run.workspaceRoot, run.workspaceRelative);
  for (const name of files) {
    const file = path.resolve(run.workspaceRoot, name);
    if (!isInside(workspace, file) || !isInside(workspace, fs.realpathSync(file))) throw new Error("Script artifact is outside the task directory.");
    hashes[name] = sha256(fs.readFileSync(file));
  }
  return hashes;
}
export async function executeScript(run: CkdRun, request: GraphScriptExecutionRequest, options: { resources: string; signal: AbortSignal; timeoutMs?: number }): Promise<WorkflowStepSubmission> {
  if (!CREATE_CKD_SOP_SCRIPT_NAMES.includes(request.script as typeof CREATE_CKD_SOP_SCRIPT_NAMES[number])) throw new Error("Script is not in the CKD allowlist.");
  options.signal.throwIfAborted(); verifyAssets(run, options.resources);
  const workspace = path.resolve(run.workspaceRoot, run.workspaceRelative);
  const key = sha256(JSON.stringify({ id: request.id, script: request.script, values: request.values, assets: run.scriptHashes }));
  const directory = path.join(workspace, "scripts", key); fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, "result.json");
  if (fs.existsSync(receipt)) {
    const saved = JSON.parse(fs.readFileSync(receipt, "utf8")) as { result: WorkflowStepSubmission; hashes: Record<string, string> };
    validate(request.outputSchema, saved.result.output);
    if (JSON.stringify(artifactHashes(run, saved.result)) !== JSON.stringify(saved.hashes)) throw new Error("Saved script artifacts changed; refusing to overwrite them.");
    return saved.result;
  }
  // A completed workbook without a receipt requires inspection, never silent replacement.
  if (request.final && fs.existsSync(path.join(workspace, "outputs")) && fs.readdirSync(path.join(workspace, "outputs")).some(name => name.endsWith(".xlsx") && !name.startsWith("."))) throw new Error("An uncommitted workbook already exists; inspect it before starting a new task.");
  const inputFile = path.join(directory, "input.json"); const outputFile = path.join(directory, "output.json");
  atomicJson(inputFile, {
    inputs: request.values, workflow: { name: run.workflowName, runId: run.id, stepId: request.id, attempt: 1 },
    paths: { workspaceRoot: run.workspaceRoot, sessionWorkspace: workspace, sessionWorkspaceRelative: run.workspaceRelative, libraryRoot: path.dirname(run.libraryPath), libraryRoots: [path.dirname(run.libraryPath)] },
  });
  fs.rmSync(outputFile, { force: true });
  const scriptRoot = path.join(options.resources, request.script);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/API_KEY|TOKEN|SECRET|PASSWORD|BASE_URL|MODEL_ID/u.test(key)) delete environment[key];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptRoot, "index.cjs"), "--input", inputFile, "--output", outputFile], { cwd: scriptRoot, env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill(); };
    const abort = () => stop(new Error("CKD execution cancelled."));
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new Error(`Script timed out: ${request.script}`)), options.timeoutMs ?? (request.timeoutSeconds ?? 120) * 1000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data: Buffer) => {
      if (Buffer.byteLength(output) + data.length > 2 * 1024 * 1024) stop(new Error("Script log exceeded 2 MiB."));
      else output += data.toString();
    });
    child.once("error", error => { failure ??= error; });
    child.once("close", code => {
      clearTimeout(timer); options.signal.removeEventListener("abort", abort);
      fs.writeFileSync(path.join(directory, "script.log"), output);
      if (failure) reject(failure); else if (code !== 0) reject(new Error(`Script ${request.script} failed (${code}): ${output.trim()}`)); else resolve();
    });
    if (options.signal.aborted) abort();
  });
  options.signal.throwIfAborted();
  if (fs.statSync(outputFile).size > 16 * 1024 * 1024) throw new Error("Script output exceeded 16 MiB.");
  const result = JSON.parse(fs.readFileSync(outputFile, "utf8")) as WorkflowStepSubmission;
  validate({ type: "object", required: ["summary", "output", "artifacts"], properties: { summary: { type: "string" }, artifacts: { type: "array", items: { type: "string" } }, output: {}, statePatch: { type: "object" } }, additionalProperties: false }, result);
  validate(request.outputSchema, result.output);
  atomicJson(receipt, { result, hashes: artifactHashes(run, result) });
  return result;
}
