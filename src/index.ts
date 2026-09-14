import { PatrickRuntime } from "./agent/index.js";
import { startServer } from "./server/index.js";

const runtime = new PatrickRuntime();

await startServer(runtime);

