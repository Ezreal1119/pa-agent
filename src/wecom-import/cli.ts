import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";
import { wecomConfig } from "./config.js";
import { WecomImportService } from "./service.js";
const cwd = process.cwd(),
  env = {
    ...(await fs
      .readFile(path.join(cwd, ".env"), "utf8")
      .then(parse)
      .catch((e) => {
        if (e.code === "ENOENT") return {};
        throw e;
      })),
    ...process.env,
  };
const dataDir = path.resolve(cwd, env.AGENT_DATA_DIR || ".data"),
  service = new WecomImportService({
    dataDir,
    config: wecomConfig(cwd, dataDir, env),
  });
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    void service.close().catch(() => {});
  });
try {
  await service.init();
  const run = await service.start();
  console.log(`WeCom import ${run.id}. Reports: ${service.root}`);
  await service.wait();
  const report = await service.get(run.id);
  for (const item of report.items)
    console.log(
      `${item.status}: ${JSON.stringify(item.description)}${item.error ? ` — ${item.error}` : ""}`,
    );
  console.log(`${report.status}: ${JSON.stringify(report.counts)}`);
  if (report.status !== "completed")
    process.exitCode = report.status === "stopped" ? 130 : 1;
} catch (e) {
  console.error(service.redact(e));
  process.exitCode = 1;
} finally {
  await service.close().catch(() => {
    process.exitCode = 1;
  });
}
