import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { translateText, verifyTranslatedFileQuality, verifyTranslation, verifyTranslationQuality } from "../src/ckd/library-translation.js";
import type { LibraryModelRequest } from "../src/ckd/library-model.js";

const fixture = (t: { after(fn: () => void): void }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-translation-quality-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return path.join(root, "jobs", "probe");
};

test("Chinese sound words left in English trigger one corrective translation and only the passing answer is cached", async t => {
    const directory = fixture(t);
    const source = "蜂鸣器“滴滴”报警，保压 30 秒。";
    const calls: LibraryModelRequest[] = [];
    const context = { directory, signal: new AbortController().signal, model: { async complete(request: LibraryModelRequest) {
        calls.push(request);
        const prompt = JSON.parse(request.prompt);
        assert.match(prompt.text, /“滴滴”/u, "sound words must be translatable, unlike UI labels");
        const output = calls.length === 1
            ? `The buzzer “滴滴” alarms; hold for ${prompt.text.match(/__CKD_LITERAL_[0-9a-f]{12}_\d+__/u)![0]} seconds.`
            : `The buzzer beeps; hold for ${prompt.text.match(/__CKD_LITERAL_[0-9a-f]{12}_\d+__/u)![0]} seconds.`;
        return { text: JSON.stringify({ text: output }), model: "mock" };
    } } };
    const result = await translateText(context, source, "English");
    assert.equal(calls.length, 2);
    assert.match(JSON.parse(calls[1]!.prompt).retryReason, /contains Chinese/u);
    assert.match(result.text, /buzzer beeps/u);
    assert.doesNotMatch(result.text, /滴/u);
    assert.equal((await translateText(context, source, "English")).text, result.text);
    assert.equal(calls.length, 2, "a validated translation is cached");
});

test("copied English prose in Chinese triggers one retry while technical labels may stay English", async t => {
    const directory = fixture(t);
    const source = "Check USB-A cable and press ON/OFF for 30 seconds.";
    const calls: LibraryModelRequest[] = [];
    const context = { directory, signal: new AbortController().signal, model: { async complete(request: LibraryModelRequest) {
        calls.push(request);
        const prompt = JSON.parse(request.prompt);
        const [button, token] = [...prompt.text.matchAll(/__CKD_LITERAL_[0-9a-f]{12}_\d+__/gu)].map(match => match[0]);
        return { text: JSON.stringify({ text: calls.length === 1
            ? `检查电缆，Check USB-A cable and press ${button} for ${token} 秒。`
            : `检查 USB-A 电缆，按 ${button} 并保持 ${token} 秒。` }), model: "mock" };
    } } };
    const result = await translateText(context, source, "中文");
    assert.equal(calls.length, 2);
    assert.match(result.text, /USB-A/u);
    assert.match(result.text, /ON\/OFF/u);
    assert.match(result.text, /30/u);
    verifyTranslationQuality(source, result.text, "中文");
});

test("two quality failures cannot create a success cache and are left for manual review", async t => {
    const directory = fixture(t);
    let calls = 0;
    const source = "蜂鸣器滴滴报警。";
    const context = { directory, signal: new AbortController().signal, model: { async complete() {
        calls++;
        return { text: JSON.stringify({ text: "The buzzer 滴滴 sounds." }), model: "mock" };
    } } };
    await assert.rejects(() => translateText(context, source, "English"), /one quality retry; manual review required/u);
    assert.equal(calls, 2);
    const cache = path.resolve(directory, "..", "..", "library-cache", "translations");
    assert.equal(fs.existsSync(cache) ? fs.readdirSync(cache).length : 0, 0);
});

test("quoted UI labels remain protected while English prose is translated", () => {
    verifyTranslationQuality("按“开始”键。", 'Press “开始”.', "English");
    assert.throws(() => verifyTranslationQuality("蜂鸣器“滴滴”报警。", 'The buzzer “滴滴” sounds.', "English"), /contains Chinese/u);
    assert.throws(() => verifyTranslationQuality("Check the tray before pressing start.", "检查，Check the tray before pressing start.", "中文"), /English phrase/u);
    assert.throws(() => verifyTranslationQuality("Hold for 30 seconds.", "保持 30 分钟。", "中文"), /numeric unit/u);
    verifyTranslationQuality("UKey", "UKey", "中文");
    assert.throws(() => verifyTranslationQuality("Camera", "Camera", "中文"), /no Chinese/u);
});

test("managed JSONL text fields are compared without treating part numbers as prose", t => {
    const directory = fixture(t);
    const source = path.join(directory, "source.jsonl"), target = path.join(directory, "target.jsonl");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(source, '{"partno":"GPOS730","name":"Check the camera cable","qty":"2"}\n');
    fs.writeFileSync(target, '{"partno":"GPOS730","name":"检查摄像头线缆","qty":"2"}\n');
    verifyTranslatedFileQuality(source, target, "中文");
    fs.writeFileSync(target, '{"partno":"GPOS730","name":"检查，Check the camera cable","qty":"2"}\n');
    assert.throws(() => verifyTranslatedFileQuality(source, target, "中文"), /English phrase/u);
});

test("numeric guard accepts a space between a number and its unit", () => {
  const source = "1.作业前检查电批扭力：0.8±0.1kgf.cm\n2.螺丝不能有打滑，打花现象";
  const target = "1. Check the electric screwdriver torque before operation: 0.8±0.1 kgf.cm\n2. Screws must not slip or be damaged.";
  assert.doesNotThrow(() => verifyTranslation(source, target));
});