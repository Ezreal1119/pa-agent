import type { FileToolConfig } from "../file-tools/config.js";
import { metered } from "../usage/ledger.js";
import { visionTokens } from "../web/run-metrics.js";
import { atomic, hash, readJson, safePath, type Usage } from "./core.js";
import type { PartialVisualEvidence } from "./visual-review.js";
import { hasNativeCompletion, nativeRecoveryEligible, NATIVE_RECOVERY_PROMPT, verifyNativeRepairs, type NativeRegion } from "./pdf-native-text.js";

/** One optional, budgeted verification of a partial OCR result. Never guesses. */
export async function recoverPdfNativeText(input: {
  config: FileToolConfig; dir: string; nativeFile: string; bytes: Buffer;
  partial: PartialVisualEvidence; signal: AbortSignal; usage: Usage; maxVision: number;
  acquire: (signal: AbortSignal) => Promise<() => void>; update: () => Promise<void>;
}): Promise<string | undefined> {
  const { config, dir, partial, signal, usage } = input;
  if (!nativeRecoveryEligible(partial.issues)) return;
  const native = await readJson<NativeRegion | null>(await safePath(dir, input.nativeFile), null);
  if (!native?.spans?.length || !hasNativeCompletion(partial.text, native)) return;
  const key = hash(JSON.stringify({ version: 1, partial, native }));
  const auditFile = await safePath(dir, `${partial.file}.native-review.json`);
  const previous = await readJson<{ key: string; status: string; result?: unknown } | null>(auditFile, null);
  // Completed repairs have a source-bound OCR cache. Failed checks are retried
  // only on explicit Retry region/Reconvert, not every unrelated Re-Sync.
  if (previous?.key === key)
    return previous.status === "verified" ? verifyNativeRepairs(partial.text, partial.issues, native, previous.result) : undefined;
  if (usage.requests >= input.maxVision) return;
  let release: (() => void) | undefined;
  try {
    release = await input.acquire(signal);
    signal.throwIfAborted();
    usage.requests++;
    await input.update();
    const timeout = AbortSignal.timeout(config.vision.timeoutMs);
    const body = await metered(config.dataDir, "sync-vision", { modelId: config.vision.model, baseUrl: config.vision.baseUrl }, async record => {
      const response = await fetch(`${config.vision.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([signal, timeout]),
        headers: { Authorization: `Bearer ${config.vision.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.vision.model, stream: false, max_tokens: 8192,
          messages: [{ role: "system", content: NATIVE_RECOVERY_PROMPT },
            { role: "user", content: [
              { type: "text", text: JSON.stringify({ label: partial.label, priorText: partial.text, issues: partial.issues,
                nativeSpans: native.spans.map((span, id) => ({ id, ...span })) }) },
              { type: "image_url", image_url: { url: `data:image/png;base64,${input.bytes.toString("base64")}` } },
            ] }],
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Native text review HTTP ${response.status}`);
      }
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body!) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error("Native text review response exceeds limit.");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await record(body.usage);
      return body;
    });
    const tokens = visionTokens(body.usage);
    if (tokens) { usage.input += tokens.input; usage.output += tokens.output; usage.recorded++; }
    await input.update();
    const choice = body.choices?.[0];
    const result = choice?.finish_reason === "stop" && typeof choice.message?.content === "string"
      ? JSON.parse(choice.message.content.replace(/^```(?:json)?\s*|\s*```$/g, "")) : null;
    const text = verifyNativeRepairs(partial.text, partial.issues, native, result);
    await atomic(auditFile, JSON.stringify({ key, sourceHash: partial.sourceHash, imageHash: partial.imageHash,
      nativeHash: hash(JSON.stringify(native)), status: text === undefined ? "unverified" : "verified", result }));
    return text;
  } catch (error) {
    if (signal.aborted) throw error;
    // A supplemental check failing is not permission to discard the original
    // visual issue. Keep it pending, and persist a bounded diagnostic only.
    await atomic(auditFile, JSON.stringify({ key, sourceHash: partial.sourceHash, imageHash: partial.imageHash, status: "unverified" }));
    return;
  } finally { release?.(); }
}
