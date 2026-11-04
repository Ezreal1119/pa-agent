import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import http from "node:http";
import { createCkdUiServer } from "../src/ckd/ui-server.js";
import type { CkdAgent } from "../src/ckd/types.js";

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
async function fixture(t: { after(fn: () => Promise<void> | void): void }, agent?: CkdAgent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ckd-ui-"));
  const libraryPath = path.join(root, "library/ckd-library-v2");
  write(path.join(libraryPath, "product_lib/TARGET/project.json"), JSON.stringify({ version: 1, projectId: "TARGET", displayName: "Target Project", aliases: ["TARGET"] }));
  for (const type of ["factory_test", "assembly_test"]) {
    const folder = path.join(libraryPath, "processes_lib", type, "camera_test");
    write(path.join(folder, "metadata"), "Camera Test\n"); write(path.join(folder, "operation_steps.txt"), "Check camera image.\n");
  }
  const app = createCkdUiServer({ dataDir: path.join(root, "data"), libraryPath, agent });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { await new Promise<void>(resolve => app.server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  const address = app.server.address(); assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const get = (route: string) => fetch(url + route);
  const post = (route: string, value: unknown, origin = url) => fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json", "X-CKD-UI": "1", Origin: origin }, body: JSON.stringify(value) });
  const wait = async (id: string) => {
    for (let retry = 0; retry < 100; retry++) { const { run } = await (await get(`/api/runs/${id}`)).json(); if (!run.busy) return run; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error("UI task did not settle.");
  };
  return { ...app, root, get, post, wait, url };
}
const input = { projectName: "TARGET", documentNumber: "UI-001", sopName: "UI Camera Test", author: "Patrick Xu" };

test("library validation API supports curl and UI, aggregates errors, rejects bad requests and never creates tasks", async t => {
  const app = await fixture(t, { async execute() { throw new Error("Validation must not call the model"); } });
  const file = path.join(app.service.libraryPath, "product_lib/TARGET/pcba_test/processes/MCU/tools.jsonl");
  const contents = '{"qty":}\n{"qty":}\n{"qty":}\n'; write(file, contents);
  const response = await fetch(app.url + "/api/library/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 200); const report = await response.json();
  assert.equal(report.valid, false); assert.equal(report.errorCount, 3); assert.equal(report.invalidFiles, 1);
  assert.deepEqual(report.errors.map((error: { line: number }) => error.line), [1, 2, 3]);
  const scoped = await app.post("/api/library/validate", { sopType: "assembly_test", templateLanguage: "English" });
  assert.equal((await scoped.json()).valid, true);
  assert.equal((await app.post("/api/library/validate", {}, "https://foreign.example")).status, 403);
  assert.equal((await app.post("/api/library/validate", { sopType: "unknown" })).status, 400);
  assert.equal((await app.post("/api/library/validate", { libraryPath: "/elsewhere" })).status, 400);
  assert.equal((await app.post("/api/library/validate", [])).status, 400);
  assert.equal(fs.readFileSync(file, "utf8"), contents); assert.equal(app.service.list().length, 0);
  fs.rmSync(app.service.libraryPath, { recursive: true });
  assert.equal((await app.post("/api/library/validate", {})).status, 404);
});

test("local UI serves form, creates durable tasks and answers using question IDs across requests", async t => {
  const app = await fixture(t);
  const page = await app.get("/"); assert.equal(page.status, 200); assert.match(await page.text(), /Project Name/u); assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/u);
  assert.equal((await app.get("/app.js")).status, 200); assert.equal((await app.get("/style.css")).status, 200);
  assert.equal((await (await app.get("/api/status")).json()).libraryReady, true);
  const invalid = await app.post("/api/runs", { projectName: "" }); assert.equal(invalid.status, 400); assert.equal(app.service.list().length, 0);
  const response = await app.post("/api/runs", input); assert.equal(response.status, 202);
  let run = await app.wait((await response.json()).run.id); assert.equal(run.status, "awaiting_clarification");
  const originalQuestion = run.pendingQuestion.id;
  const wrongAnswer = await app.post(`/api/runs/${run.id}/answer`, { questionId: originalQuestion, text: "GPOS730" }); assert.equal(wrongAnswer.status, 400);
  assert.equal((await app.wait(run.id)).pendingQuestion.id, originalQuestion);
  const answer = await app.post(`/api/runs/${run.id}/answer`, { questionId: originalQuestion, text: "手动输入 SOP Processes" }); assert.equal(answer.status, 202);
  run = await app.wait(run.id); assert.notEqual(run.pendingQuestion.id, originalQuestion); assert.equal(run.pendingQuestion.allowFreeText, true);
  assert.equal((await app.post(`/api/runs/${run.id}/answer`, { questionId: originalQuestion, text: "手动输入 SOP Processes" })).status, 400);
  const listed = await (await app.get("/api/runs")).json(); assert.equal(listed.runs.length, 1); assert.equal(listed.runs[0].inputs.projectName, "TARGET");
  const resumed = await app.post(`/api/runs/${run.id}/resume`, {}); assert.equal((await resumed.json()).run.pendingQuestion.id, run.pendingQuestion.id);
  const cancelled = await app.post(`/api/runs/${run.id}/cancel`, {}); assert.equal((await cancelled.json()).run.status, "cancelled");
});

test("UI generates and downloads an Excel, refuses foreign origins and files outside the task", async t => {
  const app = await fixture(t);
  assert.equal((await app.post("/api/runs", input, "https://foreign.example")).status, 403);
  const forbidden = await new Promise<number | undefined>((resolve, reject) => { const request = http.get(app.url + "/api/runs", { headers: { Host: "foreign.example" } }, response => { response.resume(); resolve(response.statusCode); }); request.on("error", reject); }); assert.equal(forbidden, 403);
  const start = await app.post("/api/runs", { ...input, sopType: "factory_test", factoryTestProcesses: ["Camera Test"] });
  const run = await app.wait((await start.json()).run.id); assert.equal(run.status, "completed", run.error);
  assert.equal(run.result.artifacts.length, 2); assert.ok(run.result.output.processReviews);
  assert.equal(run.result.output.imageQuality.status, "no_images");
  const report = await app.get(run.result.artifacts[1].url); assert.match(report.headers.get("content-type")!, /application\/json/u);
  assert.equal((await report.json()).overallScore, null);
  const link = run.result.artifacts[0].url; const download = await app.get(link); assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition")!, /attachment/u); assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString(), "PK");
  assert.equal((await app.get(`/api/runs/${run.id}/artifacts/99`)).status, 404);
  const saved = app.service.get(run.id); const artifact = path.resolve(saved.workspaceRoot, saved.finalResult!.artifacts[0]!);
  const external = path.join(app.root, "outside.xlsx"); write(external, "external"); fs.unlinkSync(artifact); fs.symlinkSync(external, artifact);
  assert.equal((await app.get(link)).status, 403);
});

test("HTTP start returns while model is running; polling, concurrent-action rejection and cancel work", async t => {
  const app = await fixture(t, { async execute({ signal }) { await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
  const response = await app.post("/api/runs", { ...input, projectName: "ambiguous" });
  const id = (await response.json()).run.id;
  for (let retry = 0; retry < 100 && app.service.get(id).currentNodeId !== "resolve-project"; retry++) await new Promise(resolve => setTimeout(resolve, 20));
  const snapshot = await (await app.get(`/api/runs/${id}`)).json(); assert.equal(snapshot.run.busy, true); assert.equal(snapshot.run.currentNodeId, "resolve-project");
  assert.equal((await app.post(`/api/runs/${id}/resume`, {})).status, 409);
  assert.equal((await app.post(`/api/runs/${id}/cancel`, {})).status, 200);
  assert.equal((await app.wait(id)).status, "cancelled");
});
