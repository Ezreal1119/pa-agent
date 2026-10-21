import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  PromptInstructionsStore,
  validateInstructions,
} from "../dist/prompts/instructions.js";
import { createWebServer } from "../dist/web/server.js";
import { writeMemoryFixture } from "./memory-fixtures.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, dataDir: path.join(root, ".data") };
}
test("prompt configuration is revisioned, atomic, persistent and bounded; rejects linked/corrupt input", async (t) => {
  const f = await fixture(t),
    store = new PromptInstructionsStore(f.dataDir);
  const initial = await store.load();
  assert.deepEqual(initial.instructions, []);
  let current = await store.save(
    ["默认中文。", "Use tables."],
    initial.revision,
  );
  assert.deepEqual(
    await new PromptInstructionsStore(f.dataDir).load(),
    current,
  );
  await assert.rejects(store.save(["stale"], initial.revision), /changed/);
  const competing = await Promise.allSettled([
    store.save(["one"], current.revision),
    store.save(["two"], current.revision),
  ]);
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
  current = await store.load();
  const realRename = fs.rename;
  const failure = t.mock.method(fs, "rename", async (from, to) => {
    if (to === store.file)
      throw Object.assign(new Error("Disk write failed"), { code: "EIO" });
    return realRename(from, to);
  });
  await assert.rejects(
    store.save(["must not commit"], current.revision),
    /Disk write failed/,
  );
  failure.mock.restore();
  assert.deepEqual(await store.load(), current);
  assert.ok(
    !(await fs.readdir(f.dataDir)).some(
      (n) => n.endsWith(".tmp") || n.endsWith(".lock"),
    ),
  );
  current = await store.save([], current.revision);
  assert.deepEqual(current.instructions, []);
  for (const invalid of [
    null,
    [""],
    ["  "],
    ["a\nb"],
    ["\0"],
    ["x".repeat(2001)],
    Array(101).fill("x"),
    Array(40).fill("中".repeat(1000)),
  ])
    assert.throws(() => validateInstructions(invalid));
  const large = Array(32).fill('"'.repeat(2000));
  current = await store.save(large, current.revision);
  assert.deepEqual((await store.load()).instructions, large);
  assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
  await fs.writeFile(store.file, "{bad");
  await assert.rejects(store.load(), /damaged/);
  await fs.unlink(store.file);
  const outside = path.join(f.root, "outside");
  await fs.writeFile(outside, "SECRET");
  await fs.symlink(outside, store.file);
  await assert.rejects(store.load(), /Linked/);
  await assert.rejects(store.save(["x"], current.revision), /Linked/);
  assert.equal(await fs.readFile(outside, "utf8"), "SECRET");
  await fs.unlink(store.file);
  await fs.link(outside, store.file);
  await assert.rejects(store.load(), /Linked/);
});
test("administrator prompt API previews actual resources without sessions/model calls and saves independently of active sessions", async (t) => {
  const f = await fixture(t);
  let app;
  const root = path.join(f.dataDir, "urovo-product-expert");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "SKILL.md"),
    "---\nname: urovo-product-expert\ndescription: Fixture\n---\nPRODUCT_SKILL",
  );
  await writeMemoryFixture(f.dataDir, "urovo-product-expert", "MAIN_MEMORY");
  const payloads = [];
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    payloads.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Answer" }, finish_reason: null }] })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  t.after(async () => {
    model.closeAllConnections();
    await new Promise((r) => model.close(r));
  });
  const options = {
    cwd: f.root,
    dataDir: f.dataDir,
    resourcesDir: path.resolve("resources"),
    admin: { account: "admin", password: "fixture-password" },
    model: {
      apiKey: "PRIVATE-API-KEY",
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
      modelId: "fixture",
    },
    fileTools: { enabled: true, tools: ["excel_read", "text_file_create"] },
    bridgeToken: "bridge-fixture-token-01234567890123456789",
    mcp: { apiKey: "mcp-fixture-token-01234567890123456789" },
  };
  t.after(() => app?.close());
  async function start() {
    app = await createWebServer(options);
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  let base = await start();
  let token = (await (await fetch(base + "/api/auth/status")).json()).token;
  let cookie = "";
  const req = (route, method = "GET", body, extra = {}) =>
    fetch(base + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-local-token": token,
        Cookie: cookie,
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await req("/api/prompt")).status, 401);
  for (const key of [options.bridgeToken, options.mcp.apiKey])
    assert.equal(
      (
        await req("/api/prompt", "GET", undefined, {
          Authorization: `Bearer ${key}`,
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await req("/api/wecom/prompt", "GET", undefined, {
        Authorization: `Bearer ${options.bridgeToken}`,
      })
    ).status,
    403,
  );
  const login = await req("/api/auth/login", "POST", options.admin);
  cookie = login.headers.get("set-cookie").split(";")[0];
  const before = await (await req("/api/prompt")).json();
  const body = {
    instructions: ["默认中文。", "<script>malicious()</script>"],
    revision: before.revision,
  };
  assert.equal(
    (await req("/api/prompt", "PUT", body, { "x-local-token": "" })).status,
    403,
  );
  assert.equal(
    (await req("/api/prompt", "PUT", body, { Origin: "https://evil.invalid" }))
      .status,
    403,
  );
  assert.equal(
    (await req("/api/prompt", "PUT", { ...body, path: "/tmp/arbitrary" }))
      .status,
    400,
  );
  assert.equal((await req("/api/prompt?path=outside")).status, 400);
  const previewRes = await req("/api/prompt/preview", "POST", {
    instructions: body.instructions,
    mode: "standard",
  });
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json();
  assert.match(preview.system, /MAIN_MEMORY/);
  assert.match(preview.system, /PRODUCT_SKILL/);
  assert.match(preview.system, /Administrator-provided instructions/);
  assert.ok(preview.tools.some((t) => t.name === "excel_read"));
  assert.ok(!JSON.stringify(preview).includes("PRIVATE-API-KEY"));
  assert.ok(preview.systemSections.find((s) => s.id === "attachments").example);
  assert.ok(preview.messages.every((m) => m.content.includes("Example")));
  assert.deepEqual(
    await (await req("/api/prompt")).json(),
    before,
    "preview must not save a draft",
  );
  assert.deepEqual((await (await req("/api/sessions")).json()).sessions, []);
  const mcp = await (
    await req("/api/prompt/preview", "POST", {
      instructions: body.instructions,
      mode: "mcp",
    })
  ).json();
  assert.ok(
    !mcp.tools.some((t) =>
      ["memory", "excel_read", "text_file_create"].includes(t.name),
    ),
  );
  assert.match(mcp.system, /text-only MCP/);
  assert.ok(!mcp.systemSections.some((s) => s.id === "attachments"));
  assert.equal(payloads.length, 0, "preview must not call a model");
  let saved = await (await req("/api/prompt", "PUT", body)).json();
  assert.deepEqual(saved.instructions, body.instructions);
  assert.equal((await req("/api/prompt", "PUT", body)).status, 409);
  for (const asset of ["/prompt.js", "/prompt.css"])
    assert.equal((await req(asset)).status, 200);
  const session = await (await req("/api/sessions", "POST", {})).json();
  const run = await req(`/api/sessions/${session.id}/run`, "POST", {
    text: "A web question",
  });
  assert.equal(run.status, 200);
  await run.text();
  assert.match(
    payloads.at(-1).messages.find((m) => m.role === "system").content,
    /默认中文/,
  );
  assert.deepEqual(
    payloads
      .at(-1)
      .tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    preview.tools,
  );
  saved = await (
    await req("/api/prompt", "PUT", {
      instructions: ["WEB_WECOM_NEW_INSTRUCTION"],
      revision: saved.revision,
    })
  ).json();
  await (
    await req(`/api/sessions/${session.id}/run`, "POST", {
      text: "Same session, new run",
    })
  ).text();
  assert.match(
    payloads.at(-1).messages.find((m) => m.role === "system").content,
    /WEB_WECOM_NEW_INSTRUCTION/,
  );
  const machineHeaders = { Authorization: `Bearer ${options.bridgeToken}` };
  const contact = await (
    await req("/api/wecom/sessions", "POST", {}, machineHeaders)
  ).json();
  const bridgeRun = await req(
    `/api/wecom/sessions/${contact.id}/run`,
    "POST",
    { text: "A WeCom question" },
    machineHeaders,
  );
  assert.equal(bridgeRun.status, 200);
  await bridgeRun.text();
  assert.match(
    payloads.at(-1).messages.find((m) => m.role === "system").content,
    /WEB_WECOM_NEW_INSTRUCTION/,
  );
  const html = await (await req("/")).text();
  assert.ok(
    html.indexOf('id="prompt-open"') <
      html.indexOf('id="memory-injection-open"'),
  );
  await app.close();
  base = await start();
  token = (await (await fetch(base + "/api/auth/status")).json()).token;
  const again = await req("/api/auth/login", "POST", options.admin);
  cookie = again.headers.get("set-cookie").split(";")[0];
  assert.deepEqual(await (await req("/api/prompt")).json(), saved);
  const empty = await (
    await req("/api/prompt", "PUT", {
      instructions: [],
      revision: saved.revision,
    })
  ).json();
  assert.deepEqual(empty.instructions, []);
});
