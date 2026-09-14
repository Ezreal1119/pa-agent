import type { ServerResponse } from "node:http";
import type { AppEvent } from "../agent/index.js";

export class EventStream {
  private readonly clients = new Set<ServerResponse>();

  add(response: ServerResponse): () => void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    response.write(": connected\n\n");
    this.clients.add(response);

    const remove = () => this.clients.delete(response);
    response.on("close", remove);
    return remove;
  }

  publish(event: AppEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  send(client: ServerResponse, event: AppEvent): void {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
