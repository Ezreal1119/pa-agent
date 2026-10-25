import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";
import { autoSyncSocketPath, dispatchAutoSync } from "./auto-sync-socket.js";

try {
  const disk = await fs.readFile(path.join(process.cwd(), ".env"), "utf8").then(parse).catch(e => { if (e.code === "ENOENT") return {} as Record<string, string>; throw e; });
  const dataDir = path.resolve(process.env.AGENT_DATA_DIR ?? disk.AGENT_DATA_DIR ?? path.join(process.cwd(), ".data"));
  const result = await dispatchAutoSync(autoSyncSocketPath(dataDir));
  console.log(JSON.stringify(result));
} catch {
  console.error("Auto-sync could not dispatch. Check product-expert.service and Synchronize → Sync reports → Settings.");
  process.exitCode = 1;
}
