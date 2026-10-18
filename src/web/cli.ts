import { createWebServer } from "./server.js";

const port = Number(process.env.WEB_PORT ?? 4321);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WEB_PORT must be between 1 and 65535.");
const app = await createWebServer();
app.server.on("error", error => { console.error(error.message); process.exitCode = 1; });
app.server.listen(port, "127.0.0.1", () => console.log(`Product Expert · http://127.0.0.1:${port}`));
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  void app.close().then(() => { process.exitCode = 0; });
});
