import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { KnowledgeLibrary } from "../dist/knowledge-sync/library.js";
import { hash, knowledgeLock } from "../dist/knowledge-sync/core.js";

async function setup(t) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-library-"));
  const root = path.join(data, "urovo-product-expert");
  for (const [p, text] of [
    ["SKILL.md", "skill"],
    ["MEMORY.md", "# Memory\nfact"],
    ["DT610/specs/default_202601010000/spec.md", "# DT610\nRAM 4 GB"],
    ["DT610/specs/default_202601010000/spec.pdf", "%PDF binary"],
    ["newly_added/pending.md", "inbox"],
    [".hidden/secret.md", "hidden"],
  ]) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), text);
  }
  let busy = false;
  const library = new KnowledgeLibrary(root, data, () => busy);
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  return { data, root, library, setBusy: (v) => (busy = v) };
}

test("library tree lists files recursively with edit rules and hides dot paths", async (t) => {
  const { library } = await setup(t);
  const files = Object.fromEntries((await library.tree()).map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(files).sort(), [
    "DT610/specs/default_202601010000/spec.md",
    "DT610/specs/default_202601010000/spec.pdf",
    "MEMORY.md",
    "SKILL.md",
    "newly_added/pending.md",
  ]);
  assert.equal(files["MEMORY.md"].editable, true);
  assert.equal(files["DT610/specs/default_202601010000/spec.md"].editable, true);
  assert.equal(files["SKILL.md"].editable, false);
  assert.equal(files["newly_added/pending.md"].editable, false);
  assert.equal(files["DT610/specs/default_202601010000/spec.pdf"].editable, false);
  const binary = await library.read("DT610/specs/default_202601010000/spec.pdf");
  assert.equal(binary.text, null);
  await assert.rejects(library.read("../escape.md"), /Invalid/);
  await assert.rejects(library.read(".hidden/secret.md"), /Invalid/);
});

test("library save checks the opened version, backs up, audits and enforces protections", async (t) => {
  const { data, root, library, setBusy } = await setup(t);
  const name = "DT610/specs/default_202601010000/spec.md";
  const opened = await library.read(name);
  assert.equal(opened.hash, hash("# DT610\nRAM 4 GB"));
  const saved = await library.save(name, "# DT610\nRAM 8 GB", opened.hash);
  assert.equal(saved.changed, true);
  assert.equal(await fs.readFile(path.join(root, name), "utf8"), "# DT610\nRAM 8 GB");
  assert.equal(
    await fs.readFile(path.join(data, saved.backup), "utf8"),
    "# DT610\nRAM 4 GB",
  );
  const audit = await fs.readFile(
    path.join(data, "maintenance-backups/library-edits/edits.jsonl"),
    "utf8",
  );
  assert.match(audit, /RAM|spec\.md/);
  await assert.rejects(
    library.save(name, "stale overwrite", opened.hash),
    (e) => e.status === 409 && /changed after you opened/.test(e.message),
  );
  assert.equal(await fs.readFile(path.join(root, name), "utf8"), "# DT610\nRAM 8 GB");
  const memory = await library.read("MEMORY.md");
  await library.save("MEMORY.md", "# Memory\nupdated", memory.hash);
  assert.equal(await fs.readFile(path.join(root, "MEMORY.md"), "utf8"), "# Memory\nupdated");
  const skill = await library.read("SKILL.md");
  await assert.rejects(library.save("SKILL.md", "x", skill.hash), (e) => e.status === 403);
  const inbox = await library.read("newly_added/pending.md");
  await assert.rejects(library.save("newly_added/pending.md", "x", inbox.hash), (e) => e.status === 403);
  setBusy(true);
  const current = await library.read(name);
  await assert.rejects(library.save(name, "x", current.hash), (e) => e.status === 409);
  setBusy(false);
  const release = await knowledgeLock(root).read();
  let done = false;
  const pending = library.save(name, "# DT610\nwaited", current.hash).then(() => (done = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false);
  release();
  await pending;
  assert.equal(await fs.readFile(path.join(root, name), "utf8"), "# DT610\nwaited");
});
