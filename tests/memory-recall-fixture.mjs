import fs from "node:fs/promises";
import path from "node:path";
import {renderMemoryEntry} from "../dist/agent/extra-memory.js";
import {memoryFixturePath} from "./memory-fixtures.mjs";
import {streamReply, currentTools, system} from "./ones-fixtures.mjs";

const timestamp = "2026-11-20T00:00:00.000Z";
const entry = (id, kind, content) => renderMemoryEntry({id, kind, content, created:timestamp, updated:timestamp, email:"unknown@example.test"});
export const writeMemory = async (dataDir, fact = "SQ29M R01 仅支持 M7 协议") => {
  const main = memoryFixturePath(dataDir);
  await fs.writeFile(main, "# Skill Memories\n\n" + entry("mem_target", "fact", fact) + entry("mem_other", "fact", "SQ29M Pro 支持 M99 协议，不能套用到 SQ29M。") + entry("mem_unrelated", "fact", "不相关的打印耗材规格。"));
  await fs.writeFile(path.join(path.dirname(main), "MEMORY_EXTRA.md"), "# Skill Memories\n\n" + entry("mem_extra", "correction", "SQ29M R01 仅客户测试版可以开启 M7 的调试模式。"));
};
export const memoryRequest = body => !body.stream && system(body).includes("业务记忆证据筛选器");
export const memoryRows = body => JSON.parse(body.messages[1].content).memory;
export const recallReply = (res, result, finishReason = "stop") => {
  res.writeHead(200, {"Content-Type":"application/json"});
  res.end(JSON.stringify({choices:[{finish_reason:finishReason,message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,prompt_cache_hit_tokens:30,completion_tokens:7}}));
};
export const recallFixtureReply = (body, res) => {
  if (memoryRequest(body)) {
    const evidence = memoryRows(body).filter(c => ["mem_target", "mem_extra"].includes(c.id)).map(c => ({ref:c.ref, quote:c.excerpt, scope:"SQ29M R01", relevance:"说明所查询版本的协议支持范围。"}));
    return recallReply(res, {status:evidence.length?"matched":"no_match",evidence,notes:"注意区分测试版和公开版。"});
  }
  if (currentTools(body).some(t => t.name === "recall_memory")) return streamReply(res, {text:"我查到了与该版本相关的记录。"});
  return streamReply(res, {tool:{name:"recall_memory", args:{query:"SQ29M R01 协议支持情况",background:"以前问过测试版的差异",identifiers:["SQ29M","R01"]}}});
};
