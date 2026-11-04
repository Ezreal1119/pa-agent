import { saveImagePolicy, DEFAULT_POLICY } from "../src/ckd/image-assessment.js";
import { assessmentSeen } from "./helpers/image-assessment.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { ImageQualityChecker, inspectImage, scoreImage, reviewSopImages } from "../src/ckd/image-quality.js";
import { defaultResources } from "../src/ckd/scripts.js";
import { CkdWorkflow } from "../src/ckd/service.js";
import { createCkdUiServer } from "../src/ckd/ui-server.js";
import type { LibraryModel } from "../src/ckd/library-model.js";
import type { CkdRun, WorkflowStepSubmission } from "../src/ckd/types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+axtoAAAAASUVORK5CYII=", "base64");
const seen = { imageType: "object" as const, subject: "Tool", confidence: 0.95, boundingBox: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 }, reason: "Tool surrounded by large outer margins." };
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ckd-image-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(file: string, bytes: string | Buffer) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function fake(value: unknown = seen): LibraryModel { return { async complete(request) { assert.equal(request.purpose, "vision"); assert.equal(request.imageMimeType, "image/png"); return { text: JSON.stringify(value), model: "fake-vision" }; } }; }

test("image framing score uses type-specific thresholds, conservative crop and no score for uncertain subjects", () => {
  const result = scoreImage(seen); assert.equal(result.subjectRatio, 0.25); assert.equal(result.outsideBoxRatio, 0.75);
  assert.equal(result.score, 38); assert.equal(result.status, "excessive_whitespace");
  assert.deepEqual(result.suggestedCrop, { left: 0.22, top: 0.22, right: 0.78, bottom: 0.78 });
  const full = { ...seen, boundingBox: { left: 0, top: 0, right: 1, bottom: 1 } };
  assert.equal(scoreImage(full).score, 100); assert.equal(scoreImage(full).suggestedCrop, null);
  assert.equal(scoreImage({ ...seen, imageType: "screenshot" }).score, 31);
  assert.equal(scoreImage({ ...seen, confidence: 0.6 }).score, null);
  assert.equal(scoreImage({ ...seen, imageType: "unknown", boundingBox: null }).status, "needs_review");
});

test("PNG/JPEG headers, dimensions and size limits reject invalid uploads", () => {
  assert.deepEqual(inspectImage(png), { width: 1, height: 1, mimeType: "image/png" });
  const jpeg = Buffer.from([255,216,255,192,0,8,8,0,10,0,20,1,255,217]);
  assert.deepEqual(inspectImage(jpeg), { width: 20, height: 10, mimeType: "image/jpeg" });
  assert.throws(() => inspectImage(Buffer.from("not an image")), /valid PNG/u);
  const giant = Buffer.from(png); giant.writeUInt32BE(10000, 16); giant.writeUInt32BE(10000, 20);
  assert.throws(() => inspectImage(giant), /40 megapixels/u);
  assert.throws(() => inspectImage(Buffer.alloc(10 * 1024 * 1024 + 1)), /10 MiB/u);
});

test("image Hash cache survives checker restart and ignores derived score tampering; changed bytes are reanalyzed", async t => {
  const root = fixture(t); let calls = 0;
  const model: LibraryModel = { async complete(request, signal) { calls++; return fake().complete(request, signal); } };
  let checker = new ImageQualityChecker(root, { model });
  const first = await checker.check(png); assert.equal(first.cached, false); assert.equal(first.score, 59);
  checker = new ImageQualityChecker(root, { model });
  const file = path.join(checker.root, `${first.imageHash}.json`);
  const cache = JSON.parse(fs.readFileSync(file, "utf8")); cache.score = 100; put(file, JSON.stringify(cache));
  assert.equal((await checker.check(png)).cached, true); assert.equal((await checker.check(png)).score, 59);
  const changed = Buffer.concat([png, Buffer.from("new bytes")]); await checker.check(changed); assert.equal(calls, 2);
  cache.confidence = 2; put(file, JSON.stringify(cache)); await checker.check(png); assert.equal(calls, 3);
});

test("malformed vision output, missing configuration, timeout and cancellation never create successful caches", async t => {
  const root = fixture(t);
  for (const value of [{ ...seen, boundingBox: { left: 0.8, top: 0, right: 0.2, bottom: 1 } }, { ...seen, confidence: 2 }, { ...seen, boundingBox: null }, { ...seen, boundingBox: { left: 10, top: 0, right: 100, bottom: 100 } }]) {
    const checker = new ImageQualityChecker(root, { model: fake(value) }); await assert.rejects(checker.check(png));
    assert.deepEqual(fs.readdirSync(checker.root), []);
  }
  const hang: LibraryModel = { async complete() { return new Promise(() => {}); } };
  const checker = new ImageQualityChecker(root, { model: hang, timeoutMs: 20 });
  await assert.rejects(checker.check(png), /timeout/iu);
  const controller = new AbortController(); const pending = new ImageQualityChecker(root, { model: hang }).check(png, controller.signal);
  controller.abort(new Error("test cancellation")); await assert.rejects(pending, /test cancellation/u);
  const previous = process.env.VISION_API_KEY; delete process.env.VISION_API_KEY;
  try { await assert.rejects(new ImageQualityChecker(root).check(png), /Vision model requires/u); }
  finally { if (previous !== undefined) process.env.VISION_API_KEY = previous; }
  assert.deepEqual(fs.readdirSync(checker.root), []);
});

test("concurrent identical image detection is locked and a later request reuses the result", async t => {
  const root = fixture(t); let release!: () => void;
  const model: LibraryModel = { async complete() { await new Promise<void>(resolve => { release = resolve; }); return { text: JSON.stringify(seen), model: "fake" }; } };
  const a = new ImageQualityChecker(root, { model }), b = new ImageQualityChecker(root, { model });
  const pending = a.check(png); await assert.rejects(b.check(png), /busy/u); release(); await pending;
  assert.equal((await b.check(png)).cached, true);
});

test("SOP review covers sorted selected photos and Assembly previous-station photo; caches across languages, excludes Factory extra photos", async t => {
  const root = fixture(t), run = { id: "run", workspaceRoot: root, workspaceRelative: "run" } as CkdRun;
  const effective = path.join(root, "run/effective-processes/run"), output = path.join(root, "run/outputs"); fs.mkdirSync(output, { recursive: true });
  put(path.join(effective, "one/photos/p2.png"), png); put(path.join(effective, "one/photos/p1.png"), png);
  let calls = 0; const checker = new ImageQualityChecker(root, { model: { async complete(request, signal) { calls++; return fake().complete(request, signal); } } });
  const result: WorkflowStepSubmission = { summary: "Generated", output: { sopType: "assembly_test", processReviews: [{ processId: "one", processName: "One" }] }, artifacts: [] };
  let checked = await reviewSopImages(run, result, checker, defaultResources, new AbortController().signal);
  let report = (checked.output as any).imageQuality;
  assert.equal(report.totalImages, 2); assert.equal(report.scoredUniqueImages, 1); assert.equal(report.overallScore, 59); assert.equal(calls, 1);
  assert.ok(report.images[0].path.endsWith("p1.png")); assert.equal(report.images[1].result.cached, true);
  put(path.join(effective, "one/photos/p2.png"), Buffer.from("invalid"));
  checked = await reviewSopImages(run, { ...result, output: { ...(result.output as any), sopType: "factory_test", templateLanguage: "中文" } }, checker, defaultResources, new AbortController().signal);
  assert.equal((checked.output as any).imageQuality.totalImages, 1); assert.equal(calls, 1);
  put(path.join(effective, "one/Operation_Photos/P1.PNG"), png); put(path.join(effective, "one/Previous_Station_Check_Photo.PNG"), png);
  checked = await reviewSopImages(run, { ...result, output: { ...(result.output as any), sopType: "assemble" } }, checker, defaultResources, new AbortController().signal);
  assert.equal((checked.output as any).imageQuality.totalImages, 2); assert.equal(calls, 1);
  checked = await reviewSopImages(run, result, checker, defaultResources, new AbortController().signal);
  report = (checked.output as any).imageQuality; assert.equal(report.status, "partial"); assert.equal(report.errorCount, 1); assert.equal(report.overallScore, 59);
  assert.match(checked.summary, /失败 1 张/u); assert.equal(checked.artifacts.length, 1);
});

test("real workflow emits image score/report beside unchanged business score and Excel; vision failure leaves Excel usable", async t => {
  const root = fixture(t), libraryPath = path.join(root, "library/ckd-library-v2");
  put(path.join(libraryPath, "product_lib/TARGET/project.json"), JSON.stringify({ version: 1, projectId: "TARGET", displayName: "Target", aliases: [] }));
  const folder = path.join(libraryPath, "processes_lib/factory_test/camera_test");
  put(path.join(folder, "metadata.txt"), "Camera Test\n"); put(path.join(folder, "operation_steps.txt"), "Check camera.\n"); put(path.join(folder, "photos/p1.png"), png);
  const input = { projectName: "TARGET", sopName: "Camera", documentNumber: "TEST", author: "Test", sopType: "factory_test", factoryTestProcesses: ["Camera Test"] };
  let calls = 0;
  const model: LibraryModel = { async complete(request, signal) { if(request.purpose!=="vision")return {text:JSON.stringify({subjectIndex:0,detailsVisible:"unknown",confidence:.9,comment:"缓存描述未证明相机细节"}),model:"fake"};calls++; return fake(assessmentSeen).complete(request, signal); } };
  const service = new CkdWorkflow({ dataDir: path.join(root, "data"), libraryPath, imageQualityModel: model });
  const run = await service.start(input); assert.equal(run.status, "completed", run.error);
  const result = run.finalResult!, report = (result.output as any).imageQuality;
  assert.equal(report.overallScore, 94); assert.equal(result.artifacts.length, 2); assert.ok((result.output as any).reviewSummary);
  assert.equal(JSON.parse(fs.readFileSync(path.resolve(run.workspaceRoot, result.artifacts[1]!), "utf8" )).overallScore, 94);
  const workbook = path.resolve(run.workspaceRoot, result.artifacts[0]!), originalBytes = fs.readFileSync(workbook), originalTime = fs.statSync(workbook).mtimeMs;
  // Simulate interruption after the generator receipt/cache were saved but before stage completion.
  run.status = "running"; run.currentNodeId = "generate-sop"; delete run.stageCommitted; delete run.finalResult; service.store.save(run);
  saveImagePolicy(path.join(root,"data"),{...DEFAULT_POLICY,alertThreshold:95});
  const recovered = await new CkdWorkflow({ dataDir: path.join(root, "data"), libraryPath, imageQualityModel: model }).resume(run.id);
  assert.equal(recovered.status, "completed", recovered.error); assert.equal(calls, 2);
  assert.equal((recovered.finalResult!.output as any).imageQuality.alertThreshold,80);
  assert.deepEqual(fs.readFileSync(workbook), originalBytes); assert.equal(fs.statSync(workbook).mtimeMs, originalTime);
  assert.equal((recovered.finalResult!.output as any).imageQuality.images[0].result.cached, true);
  const failing = new CkdWorkflow({ dataDir: path.join(root, "data2"), libraryPath, imageQualityModel: { async complete() { throw new Error("provider failed"); } } });
  const failed = await failing.start(input); assert.equal(failed.status, "completed", failed.error);
  assert.equal((failed.finalResult!.output as any).imageQuality.overallScore, null); assert.equal((failed.finalResult!.output as any).imageQuality.errorCount, 1);
  assert.ok(fs.existsSync(path.resolve(failed.workspaceRoot, failed.finalResult!.artifacts[0]!)));
});

test("binary image test API supports curl, reports cache and validates MIME, size, origins and missing vision", async t => {
  const root = fixture(t); const app = createCkdUiServer({ dataDir: root, libraryPath: path.join(root, "library"), imageQualityModel: fake(assessmentSeen) });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => { app.server.closeAllConnections(); app.server.close(); });
  const address = app.server.address(); assert(address && typeof address === "object"); const url = `http://127.0.0.1:${address.port}/api/images/quality`;
  const post = (image: Buffer, headers: Record<string, string> = { "Content-Type": "image/png" }) => fetch(url, { method: "POST", headers, body: new Uint8Array(image) });
  let response = await post(png); assert.equal(response.status, 200); assert.equal((await response.json()).result.score, 94);
  assert.equal((await (await post(png)).json()).result.cached, true);
  assert.equal((await post(png, { "Content-Type": "image/jpeg" })).status, 400);
  assert.equal((await post(png, { "Content-Type": "application/json" })).status, 415);
  assert.equal((await post(Buffer.from("bad"))).status, 400);
  assert.equal((await post(Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await post(png, { "Content-Type": "image/png", Origin: "https://foreign.example" })).status, 403);
  response = await post(png, { "Content-Type": "image/png", Origin: `http://127.0.0.1:${address.port}`, "X-CKD-UI": "1" }); assert.equal(response.status, 200);
});
