import { createCkdUiServer } from "./ui-server.js";
const args = process.argv.slice(2);
let port = Number(process.env.CKD_UI_PORT ?? 4317);
if (args.length) {
  if (args.length !== 2 || args[0] !== "--port") throw new Error("Usage: npm run ckd:ui -- [--port 4317]");
  port = Number(args[1]);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CKD UI port must be between 1 and 65535.");
const { server } = createCkdUiServer({ onEvent: event => console.error(`[${event.runId}] ${event.message}`) });
server.once("error", error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`CKD SOP 已启动：http://127.0.0.1:${port}\n在浏览器中打开此地址。关闭页面不会中断任务。`));
