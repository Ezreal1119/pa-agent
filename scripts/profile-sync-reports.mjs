// Isolated synthetic-report benchmark. No knowledge publication, models or network calls.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { SyncService } from "../dist/knowledge-sync/service.js";
import { emptyUsage } from "../dist/knowledge-sync/core.js";
if (process.argv[2] === "--worker") {
  const [dir, id, mode] = process.argv.slice(3);
  const service = new SyncService({
    dataDir: dir,
    maxBytes: 30 * 1048576,
    timeoutMs: 1000,
    modelId: () => "fixture",
    redact: (e) => e.message,
    planner: () => {
      throw Error("No model");
    },
    converter: () => {
      throw Error("No converter");
    },
  });
  await service.init();
  global.gc?.();
  let bytes = 0;
  for (let batch = 0; batch < 16; batch++) {
    const bodies = await Promise.all(
      Array.from({ length: 4 }, async () =>
        JSON.stringify(
          mode === "summary" ? service.summary(id) : await service.get(id),
        ),
      ),
    );
    bytes = Buffer.byteLength(bodies[0]);
    await new Promise((r) => setImmediate(r));
  }
  global.gc?.();
  const memory = process.memoryUsage();
  console.log(
    JSON.stringify({
      mode,
      polls: 64,
      responseBytes: bytes,
      peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      retainedHeapMiB: Math.round(memory.heapUsed / 1048576),
    }),
  );
  await service.close();
} else {
  const debug = path.resolve(".data/debug");
  await fs.mkdir(debug, { recursive: true });
  const dir = await fs.mkdtemp(path.join(debug, "report-profile-"));
  try {
    const id = randomUUID(),
      body = "Synthetic report line: abcdefghijklmnopqrstuvwxyz\n".repeat(
        22000,
      );
    const job = {
      id,
      kind: "sync",
      status: "completed",
      created: new Date().toISOString(),
      items: Array.from({ length: 12 }, (_, n) => ({
        id: randomUUID(),
        name: `fixture-${n}.md`,
        sourceHash: "0".repeat(64),
        bytes: 1,
        status: "published",
        stage: "Published",
        feedback: "",
        coverage: ["Complete"],
        textUsage: emptyUsage(),
        visualUsage: emptyUsage(),
        plan: {
          baseline: "fixture",
          decision: {
            action: "add",
            products: ["Fixture"],
            slot: "others",
            reason: "synthetic",
          },
          changes: [
            {
              path: `Fixture/others/fixture-${n}.md`,
              before: body + "old",
              after: body + "new",
            },
          ],
        },
      })),
    };
    const folder = path.join(dir, "knowledge-sync/jobs");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, id + ".json"), JSON.stringify(job));
    const results = [];
    for (const mode of ["full", "summary"])
      results.push(
        await new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--max-old-space-size=1024",
              "--expose-gc",
              path.resolve("scripts/profile-sync-reports.mjs"),
              "--worker",
              dir,
              id,
              mode,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let out = "",
            err = "";
          child.stdout.on("data", (b) => (out += b));
          child.stderr.on("data", (b) => (err += b));
          child.on("error", reject);
          child.on("exit", (code) =>
            code === 0
              ? resolve(JSON.parse(out))
              : reject(
                  Error(`Profile ${mode} exited ${code}: ${err.slice(-2000)}`),
                ),
          );
        }),
      );
    const report = {
      node: process.version,
      at: new Date().toISOString(),
      synthetic: true,
      concurrentPolls: 4,
      results,
    };
    await fs.writeFile(
      path.join(debug, "report-profile.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
