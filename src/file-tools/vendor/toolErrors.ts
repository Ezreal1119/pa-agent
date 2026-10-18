// Adapted from patrick-agent/src/tools/toolErrors.ts; only requested dependency closure.


export class ToolExecutionError extends Error {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolExecutionError";
    this.details = details;
  }
}
