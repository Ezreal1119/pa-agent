/** Request/admission errors shared by the MCP and plain HTTP task adapters. */
export class TaskRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
