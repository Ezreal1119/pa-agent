import test from "node:test";
import assert from "node:assert/strict";
import { tileOffsets } from "../dist/knowledge-sync/visual-tiles.js";
import { visionHttpError } from "../dist/knowledge-sync/vision-http.js";

test("visual tiles cover both axes without redundant edges or narrow trailing regions", () => {
  for (const length of [1, 28, 1191, 1680, 1684, 1799, 1800])
    assert.deepEqual(tileOffsets(length), [0]);
  assert.deepEqual(tileOffsets(1801), [0, 1]);
  assert.deepEqual(tileOffsets(3480), [0, 1680]);
  assert.deepEqual(tileOffsets(3481), [0, 1680, 1681]);
  for (let length = 1; length <= 10000; length++) {
    const offsets = tileOffsets(length);
    assert.equal(offsets[0], 0);
    assert.equal(offsets.at(-1) + Math.min(length, 1800), length);
    assert.equal(new Set(offsets).size, offsets.length);
    for (let i = 1; i < offsets.length; i++) {
      assert.ok(offsets[i] > offsets[i - 1]);
      assert.ok(offsets[i] - offsets[i - 1] <= 1680);
      assert.equal(Math.min(1800, length - offsets[i]), 1800);
    }
  }
  for (const length of [0, -1, NaN, Infinity, 1.5])
    assert.throws(() => tileOffsets(length), /dimension/);
});

test("vision HTTP errors retain provider cause and region but redact credentials and images", async () => {
  const secret = "fixture-secret-key";
  const error = await visionHttpError(new Response(JSON.stringify({
    error: {code: "invalid_image", message: `Image too short; ${secret}; Bearer other-secret; data:image/png;base64,AAAA==`},
    request: {apiKey: secret, prompt: "SHOULD NOT APPEAR"},
  }), {status: 400}), "Page 1, region x=0 y=1680 width=1191 height=4", secret);
  assert.match(error.message, /Vision HTTP 400 at Page 1/);
  assert.match(error.message, /invalid_image; Image too short/);
  assert.match(error.message, /height=4/);
  for (const privateValue of [secret, "other-secret", "AAAA", "SHOULD NOT APPEAR"])
    assert.ok(!error.message.includes(privateValue));
  assert.match(error.message, /REDACTED/);
});

test("vision error bodies are bounded and cancelled; empty responses preserve HTTP status", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(32768))); },
    cancel() { cancelled = true; },
  });
  const error = await visionHttpError(new Response(stream, {status: 502}), "Image", "fixture");
  assert.ok(cancelled);
  assert.ok(error.message.length < 1100);
  assert.match(error.message, /Vision HTTP 502/);
  assert.equal((await visionHttpError(new Response(null, {status: 400}), "Image", "")).message,
    "Vision HTTP 400 at Image");
});
