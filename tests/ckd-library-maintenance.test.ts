import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { LibraryMaintenance } from "../src/ckd/library-maintenance.js";
import { HttpLibraryModel, type LibraryModel, type LibraryModelRequest } from "../src/ckd/library-model.js";
import { createCkdUiServer } from "../src/ckd/ui-server.js";
import { acquireLibraryLock, libraryPendingMarker } from "../src/ckd/library-lock.js";
import { atomicJson } from "../src/ckd/store.js";
import { fileHash, fingerprints, resolveSources, sha } from "../src/ckd/library-source.js";
import { translateText, verifyTranslation } from "../src/ckd/library-translation.js";
import { mockTranslated } from "./helpers/mock-translation.js";
const write = (file: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
function fixture(t: {
    after(fn: () => void | Promise<void>): void;
}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-library-maintenance-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const libraryPath = path.join(root, "library/ckd-library-v2"), dataDir = path.join(root, "data");
    const common = path.join(libraryPath, "processes_lib/factory_test/camera");
    write(path.join(common, "metadata.txt"), "Camera Test");
    write(path.join(common, "operation_steps.txt"), "Check camera 1.\nKeep USB-A connected.");
    write(path.join(libraryPath, "product_lib/P/project.json"), JSON.stringify({ version: 1, projectId: "P", displayName: "P", aliases: [] }));
    const calls: LibraryModelRequest[] = [];
    const model: LibraryModel = { async complete(request) { calls.push(request); if (request.purpose === "vision")
            return { text: "A camera fixture connected by USB-A.", model: "mock-vision" }; if (request.purpose === "translate") {
            const input = JSON.parse(request.prompt);
            return { text: JSON.stringify({ text: (input.targetLanguage === "中文" ? "译文：" : "Translation: ") + mockTranslated(input.text, input.targetLanguage) }), model: "mock-text" };
        } return { text: request.system.includes("Simplified Chinese") ? "检查相机。" : "Check the camera.", model: "mock-text" }; } };
    const service = new LibraryMaintenance({ libraryPath, dataDir, model });
    return { root, libraryPath, dataDir, common, calls, model, service };
}
test("translation fills missing raw files, preserves values/assets, tracks updates and protects manual changes", async (t) => {
    const f = fixture(t);
    const tools = write(path.join(f.common, "tools_fixtures_equipment.jsonl"), '{"index":"1","name":"Fixture","specs":"GPOS710 USB-A","qty":"2"}\n');
    write(path.join(f.common, "technical_notes.txt"), "");
    write(path.join(f.common, "photos/p1.png"), Buffer.from("image bytes"));
    const original = fs.readFileSync(tools);
    let job = await f.service.start("translate", {});
    assert.equal(job.status, "completed", JSON.stringify(job));
    const cn = path.join(f.libraryPath, "processes_lib/factory_test/CN_process/camera");
    const translated = JSON.parse(fs.readFileSync(path.join(cn, "tools_fixtures_equipment.jsonl"), "utf8"));
    assert.equal(translated.qty, "2");
    assert.equal(translated.index, "1");
    assert.match(translated.specs, /GPOS710 USB-A/u);
    assert.deepEqual(fs.readFileSync(tools), original);
    assert.deepEqual(fs.readFileSync(path.join(cn, "photos/p1.png")), Buffer.from("image bytes"));
    assert.equal(fs.statSync(path.join(cn, "technical_notes.txt")).size, 0);
    assert.equal(fs.existsSync(path.join(cn, "summary.json")), false);
    const count = f.calls.length;
    job = await f.service.start("translate", {});
    assert.equal(job.status, "completed");
    assert.equal(f.calls.length, count);
    write(path.join(f.common, "metadata.txt"), "Camera Test revision 2");
    job = await f.service.start("translate", {});
    assert.match(fs.readFileSync(path.join(cn, "metadata.txt"), "utf8"), /revision 2/u);
    write(path.join(cn, "metadata.txt"), "人工确认名称");
    write(path.join(f.common, "metadata.txt"), "Camera revision 3");
    job = await f.service.start("translate", {});
    assert.equal(job.counts.conflict, 1);
    assert.equal(fs.readFileSync(path.join(cn, "metadata.txt"), "utf8"), "人工确认名称");
    fs.unlinkSync(path.join(f.common, "technical_notes.txt"));
    job = await f.service.start("translate", {});
    assert.ok(job.warnings.some(w => w.includes("source removed")));
    assert.ok(fs.existsSync(path.join(cn, "technical_notes.txt")));
    const transactions = fs.readdirSync(path.join(f.dataDir, "ckd/library-jobs", job.id));
    assert.ok(transactions.includes("state.json"));
});
test("existing independent languages, explicit empty files and photo sets are never merged or overwritten", async (t) => {
    const f = fixture(t), cn = path.join(f.libraryPath, "processes_lib/factory_test/CN_process/camera");
    write(path.join(cn, "metadata.txt"), "独立中文名称");
    write(path.join(cn, "operation_steps.txt"), "");
    fs.mkdirSync(path.join(cn, "photos"), { recursive: true });
    write(path.join(f.common, "photos/p1.png"), "png");
    const job = await f.service.start("translate", {});
    assert.equal(job.status, "completed");
    assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(path.join(cn, "metadata.txt"), "utf8"), "独立中文名称");
    assert.equal(fs.statSync(path.join(cn, "operation_steps.txt")).size, 0);
    assert.equal(fs.readdirSync(path.join(cn, "photos")).length, 0);
});
test("dry runs validate malformed JSONL without models or Library writes; invalid filters fail", async (t) => {
    const f = fixture(t);
    const before = fs.readFileSync(path.join(f.common, "metadata.txt"));
    write(path.join(f.common, "tools_fixtures_equipment.jsonl"), '{"qty":}\n');
    const job = await f.service.start("translate", { dryRun: true });
    assert.equal(job.counts.error, 1);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.libraryPath, "processes_lib/factory_test/CN_process")), false);
    assert.deepEqual(fs.readFileSync(path.join(f.common, "metadata.txt")), before);
    assert.throws(() => f.service.create("translate", { force: true }));
    assert.throws(() => f.service.create("summaries", { projectId: "../elsewhere" }));
    assert.throws(() => f.service.create("summaries", { sopType: "unknown" }));
    assert.throws(() => f.service.create("summaries", { processId: "missing" }));
    const dry = await f.service.start("summaries", { dryRun: true });
    assert.equal(dry.counts.error, 1);
    assert.equal(f.calls.length, 0);
});
test("summaries isolate languages, order images and reuse image Hash across languages/tasks; changed images re-analyze", async (t) => {
    const f = fixture(t);
    write(path.join(f.common, "photos/p2-side.png"), "side");
    write(path.join(f.common, "photos/p1.png"), "front");
    await f.service.start("translate", {});
    f.calls.length = 0;
    let job = await f.service.start("summaries", {});
    assert.equal(job.status, "completed", JSON.stringify(job));
    assert.equal(f.calls.filter(c => c.purpose === "vision").length, 2);
    const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
    const en = read(path.join(f.common, "summary.json")), cn = read(path.join(f.libraryPath, "processes_lib/factory_test/CN_process/camera/summary.json"));
    assert.deepEqual(en.instructionPhotos.map((v: any) => v.index), [1, 2]);
    assert.equal(cn.templateLanguage, "中文");
    assert.match(cn.operationSteps, /译文/u);
    assert.equal(cn.instructionPhoto.sha256, en.instructionPhoto.sha256);
    assert.equal(f.calls.filter(c => c.purpose === "overview").length, 1, "proved translations reuse a translated overview");
    const hash = fileHash(path.join(f.common, "summary.json")), count = f.calls.length;
    job = await f.service.start("summaries", {});
    assert.equal(job.counts.reused, 2);
    assert.equal(f.calls.length, count);
    assert.equal(fileHash(path.join(f.common, "summary.json")), hash);
    job = await f.service.start("summaries", { force: true });
    assert.equal(job.status, "completed");
    assert.equal(f.calls.filter(c => c.purpose === "vision").length, 2, "force does not re-describe same image");
    write(path.join(f.common, "photos/p1.png"), "front changed");
    job = await f.service.start("summaries", { templateLanguage: "English" });
    assert.equal(job.status, "completed");
    assert.equal(f.calls.filter(c => c.purpose === "vision").length, 3);
    const manifestDir = path.join(f.dataDir, "ckd/library-jobs", job.id, "transactions");
    const manifest = read(path.join(manifestDir, fs.readdirSync(manifestDir)[0]!));
    assert.equal(manifest.status, "committed");
    assert.ok(manifest.writes[0].backup);
    assert.equal(manifest.writes.length, 2);
});
test("project effective summaries preserve empty overrides and inherit changed common facts", async (t) => {
    const f = fixture(t);
    const project = path.join(f.libraryPath, "product_lib/P/factory_test/processes/camera");
    write(path.join(project, "metadata.txt"), "Project camera");
    write(path.join(project, "operation_steps.txt"), "");
    fs.mkdirSync(path.join(project, "photos"), { recursive: true });
    write(path.join(f.common, "photos/p1.png"), "image");
    write(path.join(f.common, "technical_notes.txt"), "Common note 1");
    let job = await f.service.start("summaries", { projectId: "P" });
    assert.equal(job.status, "completed");
    assert.equal(f.calls.filter(c => c.purpose === "vision").length, 0);
    const output = path.join(f.libraryPath, "product_lib/P/factory_test/derived/camera/summary.json");
    let value = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(value.operationSteps, "");
    assert.equal(value.instructionPhotos.length, 0);
    assert.equal(value.technicalNotes, "Common note 1");
    assert.equal(value.fileSources["operation_steps.txt"], "project");
    write(path.join(f.common, "technical_notes.txt"), "Common note 2");
    job = await f.service.start("summaries", { projectId: "P" });
    value = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(value.technicalNotes, "Common note 2");
    assert.equal(fs.existsSync(path.join(f.common, "summary.json")), false);
});
test("Assembly handles mixed-case files, BOM, previous-station photo and Chinese common fallback", async (t) => {
    const f = fixture(t), dir = path.join(f.libraryPath, "product_lib/P/assemble/processes/step");
    write(path.join(dir, "Metadata.txt"), "Install screen");
    write(path.join(dir, "bill_of_materials.JSONL"), '{"index":"1","partno":"A1","spec":"Screen","qty":"2"}\n');
    write(path.join(dir, "Operation_Instruction.txt"), "Install 2 screws.");
    write(path.join(dir, "Operation_Photos/p1.png"), "assembly");
    write(path.join(dir, "Previous_Station_Check.txt"), "Verify label");
    write(path.join(dir, "previous_station_check_photo.png"), "label");
    write(path.join(dir, "Self_Check.txt"), "Check fit");
    let job = await f.service.start("summaries", { sopType: "assemble", templateLanguage: "English" });
    assert.equal(job.status, "completed", JSON.stringify(job));
    const value = JSON.parse(fs.readFileSync(path.join(f.libraryPath, "product_lib/P/assemble/derived/step/summary.json"), "utf8"));
    assert.equal(value.materialDetails[0].qty, 2);
    assert.equal(value.previousStationCheckPhoto.present, true);
    assert.equal(value.selfCheck, "Check fit");
    const cn = path.join(f.libraryPath, "product_lib/P/assemble/CN_process/step");
    write(path.join(cn, "metadata.txt"), "安装屏幕");
    write(path.join(f.libraryPath, "processes_lib/assemble/CN_process/step/Operation_Instruction.txt"), "安装两颗螺丝。");
    job = await f.service.start("summaries", { sopType: "assemble", templateLanguage: "中文", projectId: "P" });
    assert.equal(job.status, "completed");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.libraryPath, "product_lib/P/assemble/CN_derived/step/summary.json"), "utf8")).operationSteps, "安装两颗螺丝。");
});
test("legacy hashes and existing photo descriptions are reused without vision; stale analysis is retained", async (t) => {
    const f = fixture(t);
    write(path.join(f.common, "photos/p1.png"), "legacy image");
    const hashes = fingerprints(resolveSources(f.common, null, "factory_test", "English"));
    write(path.join(f.common, "summary.json"), JSON.stringify({ schemaVersion: 1, sourceFingerprint: hashes.legacyFingerprint, instructionPhoto: { present: true, sha256: sha("legacy image"), description: "Existing image description", model: "historic" } }));
    write(path.join(f.common, "overview.json"), JSON.stringify({ schemaVersion: 1, sourceFingerprint: hashes.legacyFingerprint, overview: "Existing overview", model: "historic" }));
    const obsolete = write(path.join(f.libraryPath, "product_lib/P/factory_test/derived/obsolete/overview.json"), '{"overview":"keep"}');
    const job = await f.service.start("summaries", {});
    assert.equal(job.status, "completed");
    assert.equal(f.calls.length, 0);
    assert.ok(fs.existsSync(obsolete));
    assert.ok(job.warnings.some(w => w.includes("Stale analysis")));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.common, "summary.json"), "utf8")).schemaVersion, 2);
});
test("model failures and invalid translations preserve files and retry failed items on resume", async (t) => {
    const f = fixture(t);
    const service = new LibraryMaintenance({ ...f, model: { async complete() { return { text: '{"text":"wrong 99"}', model: "bad" }; } } });
    const job = await service.start("translate", {});
    assert.equal(job.status, "failed");
    assert.equal(fs.existsSync(path.join(f.libraryPath, "processes_lib/factory_test/CN_process/camera/metadata.txt")), false);
    const restarted = new LibraryMaintenance({ dataDir: f.dataDir, libraryPath: f.libraryPath, model: f.model });
    const resumed = await restarted.resume(job.id);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.counts.error, 0);
    assert.throws(() => verifyTranslation("Use 2 screws and tool.exe", "Use 3 screws and tool.exe"));
    assert.throws(() => verifyTranslation("A\nB", "A B"));
});
test("missing vision, empty overview and model timeouts do not save incomplete target pairs", async (t) => {
    const f = fixture(t);
    write(path.join(f.common, "photos/p1.png"), "new image");
    const prior = { VISION_BASE_URL: process.env.VISION_BASE_URL, VISION_API_KEY: process.env.VISION_API_KEY, VISION_MODEL_ID: process.env.VISION_MODEL_ID };
    for (const key of Object.keys(prior))
        delete process.env[key];
    t.after(() => { for (const [key, value] of Object.entries(prior))
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value; });
    let service = new LibraryMaintenance({ dataDir: f.dataDir, libraryPath: f.libraryPath });
    let job = await service.start("summaries", {});
    assert.equal(job.status, "failed");
    assert.match(job.items[0]!.message!, /VISION_/u);
    assert.equal(fs.existsSync(path.join(f.common, "summary.json")), false);
    service = new LibraryMaintenance({ dataDir: f.dataDir, libraryPath: f.libraryPath, modelTimeoutMs: 20, model: { complete: () => new Promise(() => { }) } });
    job = await service.start("summaries", {});
    assert.match(job.items[0]!.message!, /timed out/u);
    assert.equal(fs.existsSync(path.join(f.common, "overview.json")), false);
    service = new LibraryMaintenance({ dataDir: f.dataDir, libraryPath: f.libraryPath, model: { async complete() { return { text: "", model: "empty" }; } } });
    job = await service.start("summaries", {});
    assert.equal(job.status, "failed");
    assert.equal(fs.existsSync(path.join(f.common, "summary.json")), false);
});
test("external source/target changes during model calls are detected and preserved", async (t) => {
    const f = fixture(t), overview = path.join(f.common, "overview.json");
    let mutate = true;
    const service = new LibraryMaintenance({ dataDir: f.dataDir, libraryPath: f.libraryPath, model: { async complete(request, signal) { if (mutate) {
                mutate = false;
                write(overview, '{"overview":"manual"}');
            } return f.model.complete(request, signal); } } });
    let job = await service.start("summaries", {});
    assert.equal(job.status, "failed");
    assert.equal(JSON.parse(fs.readFileSync(overview, "utf8")).overview, "manual");
    assert.equal(fs.existsSync(path.join(f.common, "summary.json")), false);
    const source = path.join(f.common, "metadata.txt");
    const another = new LibraryMaintenance({ dataDir: f.dataDir, libraryPath: f.libraryPath, model: { async complete(request, signal) { write(source, "Changed externally"); return f.model.complete(request, signal); } } });
    job = await another.start("summaries", {});
    assert.equal(job.status, "failed");
    assert.equal(fs.existsSync(path.join(f.common, "summary.json")), false);
});
test("Library lock excludes other jobs and SOP execution; cancellation releases it; interrupted jobs resume explicitly", async (t) => {
    const f = fixture(t);
    let entered!: () => void;
    const ready = new Promise<void>(resolve => entered = resolve);
    const model: LibraryModel = { async complete(_request, signal) { entered(); await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); return { text: "unused", model: "unused" }; } };
    const service = new LibraryMaintenance({ dataDir: f.dataDir, libraryPath: f.libraryPath, model });
    const job = service.create("summaries", {}), running = service.resume(job.id);
    await ready;
    assert.throws(() => acquireLibraryLock(f.libraryPath), /busy/u);
    const another = new LibraryMaintenance({ dataDir: path.join(f.root, "different-data"), libraryPath: f.libraryPath, model: f.model });
    await assert.rejects(() => another.start("summaries", {}), /busy/u);
    await service.cancel(job.id);
    assert.equal((await running).status, "cancelled");
    const release = acquireLibraryLock(f.libraryPath);
    release();
    const interrupted = f.service.create("summaries", {});
    atomicJson(path.join(f.dataDir, "ckd/library-jobs", interrupted.id, "state.json"), { ...interrupted, status: "running", ownerPid: 99999999 });
    const restarted = new LibraryMaintenance({ dataDir: f.dataDir, libraryPath: f.libraryPath, model: f.model });
    assert.equal(restarted.get(interrupted.id).status, "interrupted");
    assert.equal(f.calls.length, 0);
    assert.equal((await restarted.resume(interrupted.id)).status, "completed");
});
test("interrupted paired writes recover from journal and retain backups; pending transaction blocks generation", async (t) => {
    const f = fixture(t), job = f.service.create("summaries", {}), dir = path.join(f.dataDir, "ckd/library-jobs", job.id);
    const relative = path.relative(f.libraryPath, path.join(f.common, "summary.json"));
    const data = Buffer.from('{"schemaVersion":2,"test":"recovered"}');
    write(path.join(dir, "staged/output"), data);
    job.pending = { key: "recovery", sources: { [path.relative(f.libraryPath, path.join(f.common, "metadata.txt"))]: fileHash(path.join(f.common, "metadata.txt")) }, writes: [{ relative, before: null, after: sha(data), staged: "staged/output" }] };
    atomicJson(path.join(dir, "state.json"), job);
    atomicJson(libraryPendingMarker(f.libraryPath), { jobId: job.id, directory: dir });
    assert.throws(() => acquireLibraryLock(f.libraryPath), /interrupted/u);
    // Cancel recovers the prepared write before recording cancellation; no model call is needed.
    const result = await f.service.cancel(job.id);
    assert.equal(result.status, "cancelled");
    assert.deepEqual(fs.readFileSync(path.join(f.common, "summary.json")), data);
    assert.equal(fs.existsSync(libraryPendingMarker(f.libraryPath)), false);
    assert.equal(f.calls.length, 0);
});
test("verified legacy translation manifest adopts ownership; modified targets stay independent", async (t) => {
    const f = fixture(t), source = path.relative(f.libraryPath, path.join(f.common, "metadata.txt")), target = "processes_lib/factory_test/CN_process/camera/metadata.txt";
    write(path.join(f.libraryPath, target), "历史译文");
    write(path.join(f.dataDir, "ckd/translations/2026-10-08-bilingual/staged-manifest.json"), JSON.stringify({ files: [{ source, target, sourceSha256: fileHash(path.join(f.libraryPath, source)), targetSha256: fileHash(path.join(f.libraryPath, target)), language: "中文" }] }));
    await f.service.start("translate", {});
    write(path.join(f.libraryPath, source), "New camera name");
    await f.service.start("translate", {});
    assert.match(fs.readFileSync(path.join(f.libraryPath, target), "utf8"), /^译文：[^A-Za-z]+$/u);
});
test("HTTP APIs support curl, asynchronous status/list/resume/cancel, origin checks and strict inputs", async (t) => {
    const f = fixture(t);
    const app = createCkdUiServer({ dataDir: f.dataDir, libraryPath: f.libraryPath, maintenanceModel: f.model });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    t.after(async () => { await app.maintenance.shutdown(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
    const address = app.server.address();
    assert(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const post = (route: string, value: unknown, origin?: string) => fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(value) });
    assert.equal((await post("/api/library/summaries", {}, "https://foreign.example")).status, 403);
    assert.equal((await post("/api/library/translate", { libraryPath: "/tmp" })).status, 400);
    const response = await post("/api/library/translate", { dryRun: true });
    assert.equal(response.status, 202);
    const { job } = await response.json();
    let result: any;
    for (let i = 0; i < 100; i++) {
        result = (await (await fetch(url + `/api/library/jobs/${job.id}`)).json()).job;
        if (result.status !== "running")
            break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.status, "completed");
    assert.equal((await (await fetch(url + "/api/library/jobs")).json()).jobs.length, 1);
    assert.equal((await post(`/api/library/jobs/${job.id}/resume`, {})).status, 202);
    assert.equal((await post(`/api/library/jobs/${job.id}/cancel`, {})).status, 200);
    assert.equal((await post(`/api/library/jobs/${job.id}/resume`, { force: true })).status, 400);
});
test("photo additions follow managed sets while independent empty directories remain overrides", async (t) => {
    const f = fixture(t);
    write(path.join(f.common, "photos/p1.png"), "first");
    await f.service.start("translate", {});
    write(path.join(f.common, "photos/p2.png"), "second");
    const job = await f.service.start("translate", {});
    assert.equal(job.status, "completed");
    assert.equal(fs.readFileSync(path.join(f.libraryPath, "processes_lib/factory_test/CN_process/camera/photos/p2.png"), "utf8"), "second");
});
test("independent bilingual summaries do not reuse overviews and conflicting historic photo descriptions stay local", async (t) => {
    const f = fixture(t), cn = path.join(f.libraryPath, "processes_lib/factory_test/CN_process/camera");
    write(path.join(cn, "metadata.txt"), "中文独立流程");
    write(path.join(cn, "operation_steps.txt"), "独立中文步骤");
    for (const [dir, description] of [[f.common, "English description"], [cn, "中文图片描述"]]) {
        write(path.join(dir!, "photos/p1.png"), "same bytes");
        write(path.join(dir!, "summary.json"), JSON.stringify({ instructionPhotos: [{ sha256: sha("same bytes"), description }] }));
    }
    const job = await f.service.start("summaries", {});
    assert.equal(job.status, "completed");
    assert.equal(f.calls.filter(c => c.purpose === "overview").length, 2);
    assert.equal(f.calls.filter(c => c.purpose === "vision").length, 0);
    assert.ok(job.warnings.some(w => w.includes("Different historical")));
    assert.equal(JSON.parse(fs.readFileSync(path.join(cn, "summary.json"), "utf8")).instructionPhoto.description, "中文图片描述");
});
test("source changes during interrupted writes roll back prior outputs without overwriting external edits", async (t) => {
    const f = fixture(t), job = f.service.create("summaries", {}), dir = path.join(f.dataDir, "ckd/library-jobs", job.id), output = path.join(f.common, "overview.json"), relative = path.relative(f.libraryPath, output), source = path.join(f.common, "metadata.txt");
    const before = Buffer.from('{"overview":"old"}'), after = Buffer.from('{"overview":"new"}');
    write(path.join(dir, "staged/output"), after);
    write(path.join(dir, "backups/output"), before);
    write(output, after);
    job.pending = { key: "rollback", sources: { [path.relative(f.libraryPath, source)]: fileHash(source) }, writes: [{ relative, before: sha(before), after: sha(after), staged: "staged/output", backup: "backups/output" }] };
    atomicJson(path.join(dir, "state.json"), job);
    atomicJson(libraryPendingMarker(f.libraryPath), { jobId: job.id });
    write(source, "Externally changed");
    const result = await f.service.resume(job.id);
    assert.equal(result.status, "failed");
    assert.match(result.error!, /restored prior/u);
    assert.deepEqual(fs.readFileSync(output), before);
    assert.equal(fs.existsSync(libraryPendingMarker(f.libraryPath)), false);
});
test("SOP releases the Library lock while waiting and refuses an answer before modifying state when maintenance owns it", async (t) => {
    const f = fixture(t), app = createCkdUiServer({ dataDir: f.dataDir, libraryPath: f.libraryPath, maintenanceModel: f.model });
    write(path.join(f.libraryPath, "processes_lib/assembly_test/camera/metadata.txt"), "Camera Test");
    write(path.join(f.libraryPath, "processes_lib/assembly_test/camera/operation_steps.txt"), "Check camera");
    const run = await app.service.start({ projectName: "P", documentNumber: "D", sopName: "Camera", author: "Tester" });
    assert.equal(run.status, "awaiting_clarification");
    const release = acquireLibraryLock(f.libraryPath);
    try {
        await assert.rejects(() => app.service.answer(run.id, run.pendingQuestion!.id, run.pendingQuestion!.options[0]!), /busy/u);
        assert.equal(app.service.get(run.id).pendingQuestion!.id, run.pendingQuestion!.id);
    }
    finally {
        release();
    }
});
test("model HTTP adapter sends image content, bounds requests, retries only transient provider errors", async (t) => {
    const previous = { VISION_BASE_URL: process.env.VISION_BASE_URL, VISION_API_KEY: process.env.VISION_API_KEY, VISION_MODEL_ID: process.env.VISION_MODEL_ID };
    Object.assign(process.env, { VISION_BASE_URL: "http://vision.invalid/v1", VISION_API_KEY: "test-only", VISION_MODEL_ID: "test-vision" });
    t.after(() => { for (const [key, value] of Object.entries(previous))
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value; });
    let attempts = 0;
    const requests: any[] = [];
    const client = new HttpLibraryModel({ fetch: (async (_url, init) => { requests.push(JSON.parse(init!.body as string)); attempts++; return attempts === 1 ? new Response("", { status: 429 }) : Response.json({ model: "test-vision", choices: [{ finish_reason: "stop", message: { content: "visible fixture" } }] }); }) as typeof fetch });
    const result = await client.complete({ purpose: "vision", system: "describe", prompt: "photo", image: Buffer.from("png") }, new AbortController().signal);
    assert.equal(result.text, "visible fixture");
    assert.equal(attempts, 2);
    assert.equal(requests[0].max_tokens, 4096);
    assert.match(requests[0].messages[1].content[1].image_url.url, /^data:image\/png;base64,/u);
    await client.complete({ purpose: "vision", system: "review", prompt: "photo", image: Buffer.from("png"), maxTokens: 8192 }, new AbortController().signal);
    assert.equal(requests.at(-1).max_tokens, 8192);
    attempts = 0;
    const invalid = new HttpLibraryModel({ fetch: (async () => { attempts++; return new Response("", { status: 400 }); }) as typeof fetch });
    await assert.rejects(() => invalid.complete({ purpose: "vision", system: "s", prompt: "p" }, new AbortController().signal), /HTTP 400/u);
    assert.equal(attempts, 1);
    // AbortSignal.timeout is unref'ed; the mock has no socket to keep Node 22 alive.
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const timed = new HttpLibraryModel({ timeoutMs: 10, fetch: ((_url, init) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }))) as typeof fetch });
    await assert.rejects(() => timed.complete({ purpose: "vision", system: "s", prompt: "p" }, new AbortController().signal), /timeout|timed out/iu);
});
test("symlink sources, ambiguous Assembly names and duplicate photo indexes are rejected", async (t) => {
    const f = fixture(t);
    const external = write(path.join(f.root, "external.txt"), "outside");
    fs.symlinkSync(external, path.join(f.common, "technical_notes.txt"));
    const job = await f.service.start("summaries", {});
    assert.equal(job.status, "failed");
    assert.equal(f.calls.length, 0);
    fs.unlinkSync(path.join(f.common, "technical_notes.txt"));
    write(path.join(f.common, "photos/p1.png"), "one");
    write(path.join(f.common, "photos/p1-duplicate.png"), "two");
    const duplicate = await f.service.start("summaries", {});
    assert.equal(duplicate.status, "failed");
    assert.match(duplicate.items[0]!.message!, /duplicated/u);
});
test("Chinese-origin managed files prove equivalence in either direction; missing English is generated", async (t) => {
    const f = fixture(t);
    fs.rmSync(f.common, { recursive: true });
    const cn = path.join(f.libraryPath, "processes_lib/factory_test/CN_process/camera");
    write(path.join(cn, "metadata.txt"), "检查相机");
    write(path.join(cn, "operation_steps.txt"), "连接 1 根 USB-A 线。");
    await f.service.start("translate", {});
    f.calls.length = 0;
    const job = await f.service.start("summaries", {});
    assert.equal(job.status, "completed", JSON.stringify(job));
    assert.equal(f.calls.filter(c => c.purpose === "overview").length, 1);
    assert.equal(f.calls.filter(c => c.purpose === "translate").length, 1);
});
test("one invalid Process does not block valid Process maintenance or translation; invalid UTF-8 fails explicitly", async (t) => {
    const f = fixture(t);
    const bad = path.join(f.libraryPath, "processes_lib/factory_test/bad");
    write(path.join(bad, "metadata.txt"), Buffer.from([0xff]));
    let job = await f.service.start("summaries", {});
    assert.equal(job.status, "partial_failed");
    assert.equal(job.counts.error, 1);
    assert.ok(fs.existsSync(path.join(f.common, "summary.json")));
    job = await f.service.start("translate", {});
    assert.equal(job.status, "partial_failed");
    assert.ok(fs.existsSync(path.join(f.libraryPath, "processes_lib/factory_test/CN_process/camera/metadata.txt")));
    fs.unlinkSync(path.join(bad, "metadata.txt"));
    fs.symlinkSync(path.join(f.common, "metadata.txt"), path.join(bad, "metadata.txt"));
    job = await f.service.start("translate", {});
    assert.equal(job.status, "partial_failed");
    assert.ok(job.items.some(item => item.key.startsWith("scan:") && item.status === "error"));
});

test("real OS-process Library locks exclude contenders and recover after the owner exits", async t => {
    const {spawn}=await import("node:child_process");
    const f=fixture(t),moduleUrl=new URL("../src/ckd/library-lock.ts",import.meta.url).href;
    const code=`import {acquireLibraryLock} from ${JSON.stringify(moduleUrl)}; acquireLibraryLock(${JSON.stringify(f.libraryPath)}); console.log('locked'); setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{stdio:["ignore","pipe","pipe"]});
    t.after(()=>{if(child.exitCode===null)child.kill();});
    await once(child.stdout,"data");assert.throws(()=>acquireLibraryLock(f.libraryPath),/busy/u);const exited=once(child,"exit");child.kill();await exited;
    const release=acquireLibraryLock(f.libraryPath);release();
});


test("photo-description translation preserves quoted UI labels/units and rejects damaged placeholders", async t => {
    const f = fixture(t);
    const directory = path.join(f.dataDir, "ckd/library-jobs/probe");
    const source = 'Field/dropdown: "ANT Config", "TestItem Parameter," and "<=", power 24.5 mV.\nRun `adb reboot`.';
    const context = {directory, signal: new AbortController().signal, model: {async complete(request: LibraryModelRequest) {
        const {text} = JSON.parse(request.prompt);
        assert.match(text, /Field\/dropdown/u, "ordinary slash-separated prose is not a file path");
        assert.doesNotMatch(text, /ANT Config|24.5 mV|adb reboot/u);
        return {text: JSON.stringify({text: text.replace("Field/dropdown:", "字段/下拉框：").replace(" and ", " 和 ").replace("power", "电压").replace("Run ", "执行 ")}), model: "mock"};
    }}};
    const translated = await translateText(context, source, "中文");
    assert.match(translated.text, /"TestItem Parameter,"/u);
    assert.match(translated.text, /24.5 mV/u);
    assert.match(translated.text, /`adb reboot`/u);
    verifyTranslation(source, translated.text);
    const bad = {...context, directory: path.join(f.root,"other/jobs/probe"), model: {async complete() {return {text:JSON.stringify({text:"丢失保护文本"}),model:"bad"};}}};
    await assert.rejects(()=>translateText(bad,source,"中文"), /protected literal token|same number of text segments/u);
});
test("translation protects numeric order and retries an invalid model answer before caching", async t => {
    const f = fixture(t), directory = path.join(f.dataDir, "ckd/library-jobs/retry-translation");
    const source = "Step 1: connect GPOS730. Step 2: run 24 tests.";
    let calls = 0;
    const context = {directory, signal: new AbortController().signal, model: {async complete(request: LibraryModelRequest) {
        calls++;
        const masked = JSON.parse(request.prompt).text as string;
        assert.ok(!masked.includes("GPOS730"));
        assert.ok(!masked.includes("24 tests"));
        if (calls === 1) return {text: JSON.stringify({text: masked.replace(/(__CKD_LITERAL_[0-9a-f]{12}_\d+__)(.*?)(__CKD_LITERAL_[0-9a-f]{12}_\d+__)/u, "$3$2$1")}), model: "mock"};
        return {text: JSON.stringify({text: "步骤 " + masked.replace("connect", "连接").replace("run", "运行")}), model: "mock"};
    }}};
    const first = await translateText(context, source, "中文");
    assert.equal(calls, 2);
    assert.match(first.text, /GPOS730/u);
    verifyTranslation(source, first.text);
    assert.equal((await translateText(context, source, "中文")).text, first.text);
    assert.equal(calls, 2);
});
test("repeated placeholder reordering falls back to translating only prose segments", async t => {
    const f = fixture(t), directory = path.join(f.dataDir, "ckd/library-jobs/segmented-translation");
    const source = "Step 1: connect GPOS730. Step 2: inspect 24 ports.";
    let calls = 0;
    const context = {directory, signal: new AbortController().signal, model: {async complete(request: LibraryModelRequest) {
        calls++;
        const input = JSON.parse(request.prompt);
        if (calls <= 3) return {text: JSON.stringify({text: input.text.split(/(__CKD_LITERAL_[0-9a-f]{12}_\d+__)/u).reverse().join("")}), model: "mock"};
        assert.ok(Array.isArray(input.segments));
        return {text: JSON.stringify({segments: input.segments.map((part: string) => part.replaceAll("Step", "步骤").replaceAll("connect", "连接").replaceAll("inspect", "检查").replaceAll("ports", "端口"))}), model: "mock"};
    }}};
    const result = await translateText(context, source, "中文");
    assert.equal(calls, 4);
    assert.match(result.text, /步骤 1: 连接 GPOS730/u);
    verifyTranslation(source, result.text);
});
test("segment fallback repairs invented Arabic digits and preserves single-quoted UI labels", async t => {
    const f = fixture(t), directory = path.join(f.dataDir, "ckd/library-jobs/segment-repair");
    const source = "Step 1: read 'Success' and use two cards.";
    let calls = 0;
    const context = {directory, signal: new AbortController().signal, model: {async complete(request: LibraryModelRequest) {
        calls++;
        const input = JSON.parse(request.prompt);
        if (input.text) {
            assert.ok(!input.text.includes("'Success'"));
            return {text: JSON.stringify({text: "incorrect"}), model: "mock"};
        }
        if (input.segments) return {text: JSON.stringify({segments: input.segments.map((part: string) => part.replace("Step", "步骤").replace("read", "读取").replace("and use", "并使用").replace("two cards", "2 张卡"))}), model: "mock"};
        assert.equal(input.fragment.includes("two cards"), true);
        return {text: JSON.stringify({text: input.fragment.replace("Step", "步骤").replace("read", "读取").replace("and use", "并使用").replace("two cards", "两张卡")}), model: "mock"};
    }}};
    const result = await translateText(context, source, "中文");
    assert.equal(calls, 5);
    assert.match(result.text, /'Success'/u);
    assert.match(result.text, /两张卡/u);
    verifyTranslation(source, result.text);
    verifyTranslation("When green 'Success' appears.", "出现绿色'Success'时。");
    assert.throws(() => verifyTranslation("When green 'Success' appears.", "出现绿色'Failed'时。"), /literal commands/u);
});
