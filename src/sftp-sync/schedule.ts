// Standalone privileged helper as well as the Web client. Only Node built-ins:
// install the compiled file root-owned; never execute app-writable code as root.
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const SFTP_TIMER = "product-expert-sftp.timer";
export const SFTP_SETTINGS_SOCKET = "/run/product-expert-sftp-settings.sock";
export const LIBRARY_TIMER = "product-expert-library-import.timer";
export const WECOM_TIMER = "product-expert-wecom-import.timer";
export const SYNC_TIMER = "product-expert-auto-sync.timer";
export type ScheduleSource = "sftp" | "library" | "wecom" | "sync";
export function scheduleSource(value: unknown): ScheduleSource {
  if (value === undefined || value === "sftp") return "sftp";
  if (value === "library" || value === "wecom" || value === "sync") return value;
  throw new ScheduleError(
    "Only SFTP, Library and WeCom import timers or Auto-sync timer settings are supported.",
  );
}
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export type Schedule = {
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string;
  weekday?: string;
};
export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new ScheduleError("Invalid schedule request fields.");
  return value as Record<string, unknown>;
}
export function validateSchedule(value: unknown): Schedule {
  const s = object(value, ["enabled", "frequency", "time", "weekday"]);
  if (
    typeof s.enabled !== "boolean" ||
    !["daily", "weekly"].includes(s.frequency as string) ||
    typeof s.time !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.time) ||
    (s.frequency === "weekly"
      ? !weekdays.includes(s.weekday as string)
      : s.weekday !== undefined)
  )
    throw new ScheduleError(
      "Choose daily or weekly, a valid weekday, and a Beijing time in HH:MM format.",
    );
  return {
    enabled: s.enabled,
    frequency: s.frequency as Schedule["frequency"],
    time: s.time,
    ...(s.frequency === "weekly" ? { weekday: s.weekday as string } : {}),
  };
}
export const calendarFor = (s: Schedule) =>
  `${s.frequency === "weekly" ? `${s.weekday} ` : ""}*-*-* ${s.time}:00 Asia/Shanghai`;
function scheduleFor(calendar: string, enabled: boolean): Schedule | null {
  const m = calendar.match(
    /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?\*-\*-\* ((?:[01]\d|2[0-3]):[0-5]\d):00 Asia\/Shanghai$/,
  );
  return m
    ? {
        enabled,
        frequency: m[1] ? "weekly" : "daily",
        time: m[2]!,
        ...(m[1] ? { weekday: m[1] } : {}),
      }
    : null;
}
type Command = (args: string[]) => Promise<string>;
const systemctl: Command = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/systemctl",
      ["--no-pager", "--timestamp=unix", ...args],
      {
        timeout: 8000,
        maxBuffer: 128 * 1024,
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          TZ: "Asia/Shanghai",
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        process.stderr.write(
          `systemd ${args[0]} failed: ${String(stderr || error.message)
            .replace(/[\x00-\x1f\x7f]/g, " ")
            .slice(-1500)}\n`,
        );
        reject(
          new ScheduleError(
            `systemd operation failed (${args[0]}). Inspect the import settings helper journal.`,
            503,
          ),
        );
      },
    );
  });

export class SftpTimerManager {
  // Injection is for isolated tests only. The helper entry point uses constants.
  private readonly timer: string;
  private readonly service: string;
  private readonly dropIn: string;
  constructor(
    private command: Command = systemctl,
    dropIn?: string,
    private requireRootOwner = true,
    private source: ScheduleSource = "sftp",
  ) {
    this.source = scheduleSource(source);
    this.timer =
      this.source === "library"
        ? LIBRARY_TIMER
        : this.source === "wecom"
          ? WECOM_TIMER
          : this.source === "sync" ? SYNC_TIMER : SFTP_TIMER;
    this.service = this.timer.replace(/\.timer$/, ".service");
    this.dropIn =
      dropIn ?? `/etc/systemd/system/${this.timer}.d/90-web-schedule.conf`;
  }
  async read() {
    const properties = await this.command([
      "show",
      this.timer,
      "--property=LoadState,ActiveState,UnitFileState,TimersCalendar,TimersMonotonic,NextElapseUSecRealtime,Triggers,Persistent",
    ]);
    const props = Object.fromEntries(
      properties
        .trim()
        .split("\n")
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    if (props.LoadState !== "loaded")
      throw new ScheduleError(
        `Install ${this.timer} before editing its schedule.`,
        503,
      );
    const calendars = [
      ...(props.TimersCalendar ?? "").matchAll(/OnCalendar=([^;}]+)/g),
    ].map((m) => m[1]!.trim());
    const enabled = props.UnitFileState === "enabled";
    const calendar = calendars.join("; ");
    const schedule =
      calendars.length === 1 ? scheduleFor(calendar, enabled) : null;
    const editable =
      !!schedule &&
      (this.source !== "sync" || (schedule.frequency === "daily" && props.Persistent === "no")) &&
      ["enabled", "disabled"].includes(props.UnitFileState ?? "") &&
      !props.TimersMonotonic?.trim() &&
      props.Triggers?.trim() === this.service;
    const unitText = await this.command(["cat", this.timer]);
    const seconds =
      props.NextElapseUSecRealtime?.match(/^@(\d+(?:\.\d+)?)$/)?.[1];
    return {
      available: true,
      editable,
      unit: this.timer,
      calendar,
      schedule,
      enabled,
      active: props.ActiveState === "active",
      unitFileState: props.UnitFileState,
      nextRun:
        seconds && Number(seconds) > 0
          ? new Date(Number(seconds) * 1000).toISOString()
          : null,
      revision: digest(
        JSON.stringify([unitText, props.UnitFileState, props.ActiveState]),
      ),
      note: editable
        ? undefined
        : "This timer has an unsupported or masked configuration. Manage it on the VPS first.",
    };
  }
  private async write(text: string | null) {
    const dir = path.dirname(this.dropIn);
    const stat = await fs.lstat(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (this.requireRootOwner && (stat.uid !== 0 || stat.mode & 0o022))
    )
      throw new ScheduleError(
        "The fixed timer drop-in directory must be root-owned and not writable by other users.",
        503,
      );
    const current = await fs.lstat(this.dropIn).catch((e) => {
      if (e.code === "ENOENT") return;
      throw e;
    });
    if (
      current &&
      (!current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        (this.requireRootOwner && (current.uid !== 0 || current.mode & 0o022)))
    )
      throw new ScheduleError("Unsafe timer drop-in path.", 503);
    if (text === null) {
      await fs.rm(this.dropIn, { force: true });
      return;
    }
    const temporary = path.join(dir, `.web-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", 0o644);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.dropIn);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async save(value: unknown, revision: unknown) {
    const schedule = validateSchedule(value);
    if (this.source === "sync" && schedule.frequency !== "daily")
      throw new ScheduleError("Auto-sync supports a daily Beijing-time schedule only.");
    const before = await this.read();
    if (!before.editable) throw new ScheduleError(before.note!, 409);
    if (typeof revision !== "string" || revision !== before.revision)
      throw new ScheduleError(
        "The timer changed elsewhere. Reload its status before saving again.",
        409,
      );
    if (JSON.stringify(schedule) === JSON.stringify(before.schedule))
      return before;
    const oldStat = await fs.lstat(this.dropIn).catch((e) => {
      if (e.code === "ENOENT") return;
      throw e;
    });
    if (
      oldStat &&
      (!oldStat.isFile() ||
        oldStat.isSymbolicLink() ||
        oldStat.nlink !== 1 ||
        oldStat.size > 65536 ||
        (this.requireRootOwner && (oldStat.uid !== 0 || oldStat.mode & 0o022)))
    )
      throw new ScheduleError("Unsafe timer drop-in file.", 503);
    const old = oldStat ? await fs.readFile(this.dropIn, "utf8") : null;
    // Write before touching the timer so permission/path failures cannot stop it.
    await this.write(
      `[Timer]\nOnCalendar=\nOnCalendar=${calendarFor(schedule)}\nPersistent=${this.source !== "sync"}\n`,
    );
    try {
      await this.command(["stop", this.timer]); // Never stop the running import service.
      await this.command(["daemon-reload"]);
      await this.command([
        schedule.enabled ? "enable" : "disable",
        "--now",
        this.timer,
      ]);
      const after = await this.read();
      if (
        !after.editable ||
        after.calendar !== calendarFor(schedule) ||
        after.enabled !== schedule.enabled ||
        after.active !== schedule.enabled
      )
        throw new ScheduleError(
          "systemd did not activate the requested timer settings.",
          503,
        );
      return after;
    } catch (error) {
      try {
        await this.write(old);
        await this.command(["daemon-reload"]);
        await this.command([before.enabled ? "enable" : "disable", this.timer]);
        await this.command([before.active ? "start" : "stop", this.timer]);
        if ((await this.read()).revision !== before.revision)
          throw new Error("Previous timer state could not be verified.");
      } catch {
        throw new ScheduleError(
          "Timer update and rollback failed. Inspect the helper journal and timer on the VPS before retrying.",
          503,
        );
      }
      throw new ScheduleError(
        `${(error as Error).message} Previous timer settings were restored.`,
        503,
      );
    }
  }
  async handle(value: unknown) {
    const input = object(value, [
      "operation",
      "schedule",
      "revision",
      "source",
    ]);
    if (scheduleSource(input.source) !== this.source)
      throw new ScheduleError(
        "Timer source does not match this settings handler.",
      );
    const { source: _source, ...request } = input;
    if (request.operation === "status" && Object.keys(request).length === 1)
      return this.read();
    if (request.operation === "save" && Object.keys(request).length === 3)
      return this.save(request.schedule, request.revision);
    throw new ScheduleError(
      "Only status and save of the fixed import timer are supported.",
    );
  }
}

export class SftpScheduleClient {
  constructor(
    private socketPath = SFTP_SETTINGS_SOCKET,
    private source: ScheduleSource = "sftp",
  ) {
    this.source = scheduleSource(source);
  }
  private request(
    request: object,
  ): Promise<Awaited<ReturnType<SftpTimerManager["read"]>>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let response = "",
        done = false;
      const fail = (error: Error) => {
        if (!done) {
          done = true;
          socket.destroy();
          reject(error);
        }
      };
      socket.setTimeout(45000, () =>
        fail(
          new ScheduleError(
            "Timer settings response timed out. Reload status to check whether it was applied.",
            503,
          ),
        ),
      );
      socket.on("connect", () =>
        socket.end(
          JSON.stringify({
            ...request,
            ...(this.source !== "sftp" ? { source: this.source } : {}),
          }) + "\n",
        ),
      );
      socket.on("data", (chunk) => {
        response += chunk;
        if (response.length > 65536)
          fail(new ScheduleError("Invalid timer settings response.", 503));
      });
      socket.on("error", () =>
        fail(
          new ScheduleError(
            "Timer settings helper is unavailable. Install its VPS socket/service templates or check socket permissions.",
            503,
          ),
        ),
      );
      socket.on("end", () => {
        if (done) return;
        done = true;
        try {
          const result = JSON.parse(response);
          if (!result.ok)
            throw new ScheduleError(
              result.error || "Timer settings failed.",
              [400, 409, 503].includes(result.status) ? result.status : 503,
            );
          resolve(result.result);
        } catch (error) {
          reject(
            error instanceof ScheduleError
              ? error
              : new ScheduleError("Invalid timer settings response.", 503),
          );
        }
      });
    });
  }
  async status() {
    try {
      return await this.request({ operation: "status" });
    } catch (error) {
      return {
        available: false,
        editable: false,
        note: (error as Error).message,
      };
    }
  }
  save(schedule: unknown, revision: unknown) {
    return this.request({
      operation: "save",
      schedule: validateSchedule(schedule),
      revision,
    });
  }
}

async function serveConnection() {
  process.stdout.on("error", () => {}); // The browser may disconnect after a successful apply.
  try {
    if (process.platform !== "linux" || process.getuid?.() !== 0)
      throw new ScheduleError(
        "The timer helper must run as root under its Linux systemd socket unit.",
        503,
      );
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 16384)
        throw new ScheduleError("Schedule request exceeds 16 KiB.");
    }
    let request;
    try {
      request = JSON.parse(input);
    } catch {
      throw new ScheduleError("Invalid schedule JSON.");
    }
    const result = await new SftpTimerManager(
      undefined,
      undefined,
      true,
      scheduleSource(request?.source),
    ).handle(request);
    process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  } catch (error) {
    process.stderr.write(
      `Import timer settings: ${error instanceof Error ? error.message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1500) : "Unknown error"}\n`,
    );
    process.stdout.write(
      JSON.stringify({
        ok: false,
        status: error instanceof ScheduleError ? error.status : 503,
        error:
          error instanceof ScheduleError
            ? error.message
            : "Timer settings failed. Inspect the helper journal.",
      }) + "\n",
    );
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await serveConnection();
