import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { resolveConfig } from "../config.js";
export interface LibraryModelRequest {
    purpose: "translate" | "overview" | "vision";
    system: string;
    prompt: string;
    image?: Buffer;
    imageMimeType?: string;
    json?: boolean;
    maxTokens?: number;
}
export interface LibraryModelResult {
    text: string;
    model: string;
}
export interface LibraryModel {
    complete(request: LibraryModelRequest, signal: AbortSignal): Promise<LibraryModelResult>;
}
export class ModelProviderError extends Error {
    constructor(readonly status:number,readonly detail:string) { super(`Model provider HTTP ${status}${detail?`: ${detail}`:''}`); }
}
export class ModelOutputError extends Error {}
/** Keep bounded provider diagnostics, never request bodies, credentials or embedded images. */
async function providerDetail(response:Response,secrets:string[]):Promise<string> {
    if(!response.body)return '';
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;
    try { while(length<8192){const part=await reader.read();if(part.done)break;const chunk=part.value.subarray(0,8192-length);chunks.push(chunk);length+=chunk.length;} }
    finally { await reader.cancel(); }
    let detail='';
    try { const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));const error=body.error??body;detail=[error.code,error.type,error.message].filter(v=>typeof v==='string').join(' / '); }
    catch { return 'Non-JSON provider error response.'; }
    for(const secret of secrets)if(secret)detail=detail.split(secret).join('[redacted]');
    return detail.replace(/Bearer\s+\S+/giu,'Bearer [redacted]').replace(/data:[^\s"']+/giu,'[image redacted]').replace(/[\r\n]+/gu,' ').slice(0,600);
}
export class HttpLibraryModel implements LibraryModel {
    constructor(private readonly options: {
        timeoutMs?: number;
        retries?: number;
        fetch?: typeof fetch;
    } = {}) { }
    async complete(request: LibraryModelRequest, signal: AbortSignal): Promise<LibraryModelResult> {
        const vision = request.purpose === "vision";
        const config = vision ? { baseUrl: process.env.VISION_BASE_URL, apiKey: process.env.VISION_API_KEY, modelId: process.env.VISION_MODEL_ID, maxTokens: 4096 } : resolveConfig().model;
        for (const key of ["baseUrl", "apiKey", "modelId"] as const)
            if (!config[key]?.trim())
                throw new Error(vision ? "Vision model requires VISION_BASE_URL, VISION_API_KEY and VISION_MODEL_ID." : `Missing text model ${key}`);
        const content = request.image ? [{ type: "text", text: request.prompt }, { type: "image_url", image_url: { url: `data:${request.imageMimeType ?? "image/png"};base64,${request.image.toString("base64")}` } }] : request.prompt;
        const retries = this.options.retries ?? 2;
        for (let attempt = 0;; attempt++) {
            signal.throwIfAborted();
            const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 300000)]);
            let retry = false;
            try {
                const response = await (this.options.fetch ?? fetch)(config.baseUrl!.replace(/\/+$/u, "") + "/chat/completions", {
                    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` }, signal: bounded,
                    body: JSON.stringify({ model: config.modelId, messages: [{ role: "system", content: request.system }, { role: "user", content }], max_tokens: request.maxTokens ?? config.maxTokens, ...(!vision && new URL(config.baseUrl!).hostname === "api.deepseek.com" ? { thinking: { type: "disabled" } } : {}), ...(request.json ? { response_format: { type: "json_object" } } : {}) }),
                });
                if (!response.ok) {
                    retry = response.status === 429 || response.status >= 500;
                    const detail=await providerDetail(response,[config.apiKey!]);
                    throw new ModelProviderError(response.status,detail);
                }
                const result = await response.json() as {
                    model?: string;
                    choices?: {
                        finish_reason?: string;
                        message?: {
                            content?: string;
                        };
                    }[];
                };
                const choice = result.choices?.[0];
                const text = choice?.message?.content?.trim();
                if (!text || (choice?.finish_reason && choice.finish_reason !== "stop"))
                    throw new ModelOutputError(`Model returned empty or incomplete output (${choice?.finish_reason ?? "missing"}).`);
                return { text, model: result.model || config.modelId! };
            }
            catch (error) {
                signal.throwIfAborted();
                if (bounded.aborted || attempt >= retries || (!retry && !(error instanceof TypeError)))
                    throw error;
                await delay(Math.min(1000 * 2 ** attempt, 10000), undefined, { signal });
            }
        }
    }
}
