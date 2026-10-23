import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { safePath } from "../knowledge-sync/core.js";
import type { WecomConfig } from "./config.js";
export const COMMANDS = {
  "sheet.version.get": ["sheet", "version", "get"],
  "sheet.get": ["sheet", "get"],
  "sheet.workbook.get": ["sheet", "workbook", "get"],
  "sheet.cells.get": ["sheet", "cells", "get"],
  "sheet.merge.get": ["sheet", "merge", "get"],
  "doc.contents.get": ["doc", "contents", "get"],
} as const;
export type Operation = keyof typeof COMMANDS;
export interface Reader {
  run(
    operation: Operation,
    input: Record<string, unknown>,
    signal: AbortSignal,
    outputDir?: string,
  ): Promise<any>;
}
export class WecomError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
    readonly retryable = false,
  ) {
    super(message);
  }
}
export class CliReader implements Reader {
  constructor(private config: WecomConfig) {}
  async preflight() {
    await safePath(this.config.authDir);
    const stat = await fs.stat(this.config.authDir).catch(() => null);
    if (!stat?.isDirectory())
      throw new WecomError(
        "CLI authorization directory is missing. Initialize official CLI credentials with WECOM_CLI_CONFIG_DIR first.",
        true,
      );
  }
  async run(
    operation: Operation,
    input: Record<string, unknown>,
    signal: AbortSignal,
    outputDir?: string,
  ) {
    const command = COMMANDS[operation];
    if (!command) throw new WecomError("Operation is not allowed.", true);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.config.authDir,
      LANG: "C.UTF-8",
      WECOM_CLI_CONFIG_DIR: this.config.authDir,
    };
    // Deliberately do not inherit Bridge bot secrets, access tokens, additional headers or CLI debug logging.
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      const timed = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.config.timeoutMs),
      ]);
      const args = [
        ...command,
        "--json",
        JSON.stringify(input),
        ...(outputDir ? ["--output-dir", outputDir] : []),
      ];
      const result = await new Promise<{
        error: NodeJS.ErrnoException | undefined;
        stdout: string;
      }>((resolve) => {
        // npm's launcher starts a native child. Give both a private process group,
        // so cancellation/timeouts cannot leave a read running behind the launcher.
        const group = process.platform !== "win32";
        const child = spawn(this.config.cliBin, args, {
          cwd: outputDir || this.config.authDir,
          env,
          shell: false,
          detached: group,
          signal: timed,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "ignore"],
        });
        let error: NodeJS.ErrnoException | undefined,
          size = 0;
        const chunks: Buffer[] = [];
        const kill = () => {
          try {
            if (group && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {}
        };
        child.on("error", (e) => {
          error = e;
        });
        child.stdout.on("data", (bytes: Buffer) => {
          size += bytes.length;
          if (size > 16 * 1048576) {
            error = Object.assign(new Error("Response exceeds buffer limit."), {
              code: "MAX_BUFFER",
            });
            kill();
          } else chunks.push(bytes);
        });
        child.on("close", (code) => {
          timed.removeEventListener("abort", kill);
          kill();
          if (code !== 0 && !error)
            error = Object.assign(new Error("CLI exited unsuccessfully."), {
              code: "CLI_EXIT",
            });
          resolve({ error, stdout: Buffer.concat(chunks).toString("utf8") });
        });
        timed.addEventListener("abort", kill, { once: true });
        if (timed.aborted) kill();
      });
      signal.throwIfAborted();
      let body: any;
      try {
        body = JSON.parse(result.stdout);
      } catch {}
      let failure: WecomError | undefined;
      if (body?.error || body?.errcode) {
        const e = body.error || body,
          code = String(e.code ?? e.errcode ?? "");
        const auth =
          /auth|unauthor|token|credential|secret|bind|授权|凭证/i.test(
            `${e.type || ""} ${e.message || e.errmsg || ""}`,
          ) ||
          ["853004", "893201", "40001", "40014", "42001", "401"].includes(code);
        const temporary =
          ["45009", "45011", "429"].includes(code) ||
          /timeout|network|rate.?limit|频率|限流|网络|超时/i.test(
            `${e.type || ""} ${code} ${e.message || e.errmsg || ""}`,
          );
        // Never propagate provider text: it can contain credential material or remote instructions.
        failure = new WecomError(
          auth
            ? "WeCom authorization failed. Re-authorize the CLI on the VPS."
            : `WeCom rejected this read${/^\d+$/.test(code) ? ` (code ${code})` : ""}. Check document permissions and CLI compatibility.`,
          auth,
          temporary && !auth,
        );
      } else if (result.error) {
        const missing = result.error.code === "ENOENT";
        failure = new WecomError(
          missing
            ? "Official wecom-cli could not start. Check WECOM_CLI_BIN and authorization directory."
            : timed.aborted
              ? "WeCom read timed out."
              : "Official wecom-cli failed. Check its installation and authorization.",
          missing,
          timed.aborted ||
            ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(
              String(result.error.code || ""),
            ),
        );
      } else if (!body || typeof body !== "object" || Array.isArray(body))
        failure = new WecomError("CLI returned invalid JSON.");
      if (!failure) return body;
      if (!failure.retryable || attempt >= this.config.attempts) throw failure;
      await delay(500 * 2 ** (attempt - 1), undefined, { signal });
    }
  }
}
/** Only open files produced in the private directory for this one read. */
export async function containedText(
  directory: string,
  filename: unknown,
  maxBytes: number,
) {
  if (typeof filename !== "string")
    throw new WecomError("CLI did not return a valid response file.");
  const absolute = path.resolve(directory, filename),
    relative = path.relative(directory, absolute);
  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new WecomError("CLI response file is outside its request directory.");
  await safePath(directory, relative);
  const h = await fs.open(absolute, "r");
  try {
    const stat = await h.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
      throw new WecomError("CLI response file is invalid or oversized.");
    return new TextDecoder("utf-8", { fatal: true }).decode(await h.readFile());
  } finally {
    await h.close();
  }
}
