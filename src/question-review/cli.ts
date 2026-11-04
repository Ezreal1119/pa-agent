import { parseArgs } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { requestReview } from "./transport.js";

// No .env, credentials, raw-session export or independent review engine here.
// The already-running service supplies its current model over private IPC.
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    "data-dir": { type: "string" }, from: { type: "string" }, to: { type: "string" }, "last-hours": { type: "string" }, "request-id": { type: "string" }, retry: { type: "string" },
    wait: { type: "boolean", default: false }, format: { type: "string", default: "markdown" }, enabled: { type: "string" }, time: { type: "string" }, "time-zone": { type: "string" }, "max-duration-ms": { type: "string" }, "max-model-requests": { type: "string" },
  } });
  const file = path.join(path.resolve(values["data-dir"] ?? process.env.AGENT_DATA_DIR ?? ".data"), "question-review", "control.sock");
  const request = (input: unknown) => requestReview(file, input);
  const command = positionals[0] ?? "status", id = positionals[1];
  let result: any;
  if (command === "settings") {
    const current = await request({ op: "settings.get" });
    const edits: Record<string, unknown> = {};
    if (values.enabled !== undefined) { if (!["true", "false"].includes(values.enabled)) throw new Error("enabled must be true or false"); edits.enabled = values.enabled === "true"; }
    for (const [flag, key] of [["time", "time"], ["time-zone", "timeZone"], ["max-duration-ms", "maxDurationMs"], ["max-model-requests", "maxModelRequests"]] as const) if (values[flag] !== undefined) edits[key] = key.startsWith("max") ? Number(values[flag]) : values[flag];
    result = Object.keys(edits).length ? await request({ op: "settings.put", input: { ...current.settings, ...edits } }) : current;
  } else if (command === "run") {
    const to = values.to ?? new Date().toISOString(), hours = Number(values["last-hours"] ?? 48);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 31 * 24 || !Number.isFinite(Date.parse(to))) throw new Error("Invalid time range");
    result = await request({ op: "runs.start", input: { from: values.from ?? new Date(Date.parse(to) - hours * 3600000).toISOString(), to, requestId: values["request-id"] ?? randomUUID(), ...(values.retry ? { retryRunId: values.retry } : {}) } });
    if (values.wait) while (["queued", "running"].includes(result.status)) { await new Promise(resolve => setTimeout(resolve, 2000)); result = await request({ op: "runs.get", id: result.id }); }
  } else if (command === "status") result = await request(id ? { op: "runs.get", id } : { op: "settings.get" });
  else if (command === "list") result = await request({ op: "runs.list" });
  else if (command === "cancel" && id) result = await request({ op: "runs.cancel", id });
  else if (command === "export" && id && ["json", "markdown"].includes(values.format!)) result = await request({ op: "runs.export", id, format: values.format });
  else throw new Error("Use settings, run, status [id], list, cancel <id> or export <id>");
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  if (command === "run" && values.wait && result.status !== "completed") process.exitCode = 2;
} catch (error) {
  // Do not echo provider messages, raw input, credentials or filesystem locations.
  console.error("Question review CLI did not complete. Verify arguments, service availability and checkpoint status."); process.exitCode = 1;
}
