import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const FIRMWARE_TOOL_NAME = "firmware";
export const FIRMWARE_GUIDANCE = "OS firmware download/upload requires the explicit WeCom /firmware command. Tell users to use /firmware; ordinary chat and MCP cannot start it. Never infer confirmation or claim an upload has started. The dedicated command workflow extracts the SQ model, six-digit date and two-digit index, requires exactly one real FTP match, obtains explicit owner confirmation and performs background download/R2 upload.";
export function createFirmwareTool(select?: (ids: string[], reason: string) => Promise<unknown>) {
  return defineTool({ name: FIRMWARE_TOOL_NAME, label: "OS 固件下载与上传", description: "OS firmware workflow tool. In a trusted /firmware matching session, submit only candidate IDs from the supplied real FTP listing, preserving all plausible variants. An empty list means uncertain/no match. This tool cannot bypass the owner's explicit confirmation or directly start a transfer in ordinary chat.",
    parameters: Type.Object({ candidate_ids: Type.Array(Type.String({ pattern: "^[a-f0-9]{32}$" }), { maxItems: 12, uniqueItems: true }), reason: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }),
    execute: async (_id, args) => {
      const value = select ? await select(args.candidate_ids, args.reason) : { requires_command: true, message: "请在企微发送 /firmware 后输入固件名；普通聊天不能启动固件任务。" };
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
    },
  });
}
