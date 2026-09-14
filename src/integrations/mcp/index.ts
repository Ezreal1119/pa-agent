/** MCP client integration will be added here when it is needed. */
export interface McpConnection {
  readonly name: string;
  close(): Promise<void>;
}

