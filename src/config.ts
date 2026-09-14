import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  rootDir: path.resolve(srcDir, ".."),
  cwd: path.resolve(process.env.PI_PATRICK_CWD ?? process.cwd()),
  dataDir: path.resolve(process.env.PI_PATRICK_DATA_DIR ?? path.join(process.cwd(), ".data")),
  agentDir: process.env.PI_AGENT_DIR ?? getAgentDir(),
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
};

export const paths = {
  sessions: path.join(config.dataDir, "sessions"),
  resources: path.join(config.rootDir, "resources"),
  webDist: path.join(config.rootDir, "web", "dist"),
};
