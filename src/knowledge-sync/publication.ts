import fs from "node:fs/promises";
import path from "node:path";
import {
  atomic,
  excluded,
  catalog,
  fingerprint,
  knowledgeLock,
  safePath,
  readJson,
  SyncError,
  type Plan,
  type Change,
} from "./core.js";

type Journal = {
  state: "prepared" | "committed" | "rolled_back";
  changes: Change[];
  created: string;
};
export class Publisher {
  constructor(
    readonly root: string,
    readonly stateDir: string,
  ) {}
  async recover() {
    const dir = await safePath(this.stateDir, "transactions");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = await safePath(dir, name);
      const journal = await readJson<Journal | null>(file, null);
      if (!journal) continue;
      if (journal.state === "prepared") {
        await this.apply(journal.changes, false);
        journal.state = "rolled_back";
        await atomic(file, JSON.stringify(journal));
      }
      if (Date.parse(journal.created) < Date.now() - 90 * 86400000)
        await fs.unlink(file);
    }
  }
  async prune() {
    const dir = await safePath(this.stateDir, "transactions");
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = await safePath(dir, name);
      const journal = await readJson<Journal | null>(file, null);
      if (
        journal &&
        journal.state !== "prepared" &&
        Date.parse(journal.created) < Date.now() - 90 * 86400000
      )
        await fs.unlink(file);
    }
  }
  async committed(id: string) {
    return (
      (
        await readJson<Journal | null>(
          path.join(this.stateDir, "transactions", `${id}.json`),
          null,
        )
      )?.state === "committed"
    );
  }
  async publish(id: string, plan: Plan, signal: AbortSignal) {
    const release = await knowledgeLock(this.root).write(signal);
    try {
      signal.throwIfAborted();
      if (fingerprint(await catalog(this.root)) !== plan.baseline)
        throw new SyncError(
          "Knowledge changed since this plan was prepared. Re-Sync or preview again.",
          409,
        );
      const file = await safePath(this.stateDir, `transactions/${id}.json`);
      const journal: Journal = {
        state: "prepared",
        changes: plan.changes,
        created: new Date().toISOString(),
      };
      await atomic(file, JSON.stringify(journal));
      // Once prepared, finish or roll back even when the client cancels.
      try {
        await this.apply(plan.changes, true);
        journal.state = "committed";
        await atomic(file, JSON.stringify(journal));
      } catch (error) {
        try {
          await this.apply(plan.changes, false);
          journal.state = "rolled_back";
          await atomic(file, JSON.stringify(journal));
        } catch (rollbackError) {
          knowledgeLock(this.root).fail(
            new Error(
              "Knowledge recovery failed. Restart after correcting disk/permission errors.",
            ),
          );
          throw rollbackError;
        }
        throw error;
      }
    } finally {
      release();
    }
  }
  private async apply(changes: Change[], after: boolean) {
    for (const change of changes) {
      if (excluded(change.path) || !change.path.endsWith(".md"))
        throw new SyncError("Protected transaction path.");
      const file = await safePath(this.root, change.path);
      const text = after ? change.after : change.before;
      if (text === null) {
        await fs.rm(file, { force: true });
        // Retired source version directories must not look like active slots.
        const parts = change.path.split("/");
        if (parts.length === 4 && parts[0] !== "product-knowledge-vault") {
          const directory = await safePath(
            this.root,
            parts.slice(0, -1).join("/"),
          );
          await fs.rmdir(directory).catch((error) => {
            if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code))
              throw error;
          });
        }
      } else await atomic(file, text);
    }
  }
}
