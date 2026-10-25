import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ResearchService } from "./service.js";
import { today, ResearchError, scenes } from "./domain.js";
export async function researchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: ResearchService,
  readBody: (req: IncomingMessage, max?: number) => Promise<any>,
) {
  const json = (status: number, data: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(data));
  };
  const input = async <T>(schema: z.ZodType<T>) => {
    const result = schema.safeParse(await readBody(req, 16000));
    if (!result.success) throw new ResearchError(400, "请求字段或格式不合法");
    return result.data;
  };
  const pathname = url.pathname.slice("/api/research".length);
  const method = req.method;
  if (pathname === "/runs" && method === "GET")
    return json(200, await service.status());
  if (pathname === "/runs" && method === "POST") {
    const body = await input(
      z.object({ endDate: z.string().optional(), budgetCny: z.number().min(.05).max(100).optional() }).strict(),
    );
    return json(202, await service.start(body.endDate ?? today(), body.budgetCny));
  }
  const run = pathname.match(/^\/runs\/([a-f0-9-]{36})(\/stop)?$/);
  if (run && method === "GET" && !run[2])
    return json(200, await service.status(run[1]));
  if (run && method === "POST" && run[2]) {
    await input(z.object({}).strict());
    return json(200, await service.stop(run[1]!));
  }
  const item = pathname.match(/^\/items\/([a-f0-9-]{36})(\/archive)?$/);
  if (item && method === "GET" && !item[2]) {
    const value = await service.store.item(item[1]!);
    if (!value) throw new ResearchError(404, "资讯不存在");
    return json(200, value);
  }
  if (item && method === "POST" && item[2]) {
    const body = await input(
      z.object({ reason: z.string().min(1).max(2000) }).strict(),
    );
    return json(200, await service.store.archive(item[1]!, body.reason));
  }
  if ((pathname === "/items" || pathname === "/export") && method === "GET") {
    const end = url.searchParams.get("endDate") ?? today();
    const days = Number(url.searchParams.get("days") ?? 14);
    const scene = url.searchParams.get("scene") ?? "";
    const tag = url.searchParams.get("tag") ?? "";
    if (scene && !(scene in scenes)) throw new ResearchError(400, "未知场景");
    if (pathname === "/items")
      return json(200, await service.browse(end, days, scene, tag));
    const markdown = await service.export(end, days);
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="urovo-${end}-${days}d.md"`,
    });
    res.end(markdown);
    return;
  }
  throw new ResearchError(404, "研究接口不存在");
}
