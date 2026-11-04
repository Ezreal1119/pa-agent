import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acquireDirectoryLock } from "../src/ckd/library-lock.js";
import { currentLockIdentity } from "../src/ckd/lock-owner.js";
import { CkdStore } from "../src/ckd/store.js";

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-lock-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function oldLock(lock: string, owner: object): void {
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner));
}

test("a live directory lock still excludes another operation", t => {
  const lock = path.join(fixture(t), "library.lock");
  const release = acquireDirectoryLock(lock);
  try { assert.throws(() => acquireDirectoryLock(lock), /busy/u); }
  finally { release(); }
});

test("reused PID from a different boot or process is reclaimed", { skip: process.platform !== "linux" }, async t => {
  const root = fixture(t);
  const identity = currentLockIdentity();
  assert.ok(identity.bootId && identity.startTicks);

  const libraryLock = path.join(root, "library.lock");
  oldLock(libraryLock, { pid: process.pid, token: "old", bootId: "previous-boot", startTicks: identity.startTicks });
  const releaseLibrary = acquireDirectoryLock(libraryLock);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(libraryLock, "owner.json"), "utf8")).token, "old");
  releaseLibrary();

  const store = new CkdStore(root);
  const id = randomUUID();
  const runLock = path.join(store.directory(id), "run.lock");
  oldLock(runLock, { pid: process.pid, token: "old", bootId: identity.bootId, startTicks: "0" });
  await store.locked(id, async () => {
    assert.notEqual(JSON.parse(fs.readFileSync(path.join(runLock, "owner.json"), "utf8")).token, "old");
  });
  assert.equal(fs.existsSync(runLock), false);
});

test("a legacy PID-only lock from before this boot is reclaimed", { skip: process.platform !== "linux" }, t => {
  const root = fixture(t);
  const lock = path.join(root, "legacy.lock");
  oldLock(lock, { pid: process.pid, token: "legacy" });
  const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  const beforeBoot = new Date(Date.now() - (uptime + 60) * 1000);
  fs.utimesSync(lock, beforeBoot, beforeBoot);
  const release = acquireDirectoryLock(lock);
  release();
  assert.equal(fs.existsSync(lock), false);
});
