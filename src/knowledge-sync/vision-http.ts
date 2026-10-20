/** Read only bounded provider error data; never include credentials or image payloads. */
export async function visionHttpError(
  response: Response,
  label: string,
  apiKey: string,
): Promise<Error> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  try {
    while (reader && size < 64 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, 64 * 1024 - size);
      chunks.push(part);
      size += part.length;
    }
  } catch {
    // The HTTP status remains useful even when the error body is unavailable.
  } finally {
    await reader?.cancel().catch(() => {});
  }
  let detail = Buffer.concat(chunks).toString("utf8");
  try {
    const body = JSON.parse(detail);
    const error = body.error ?? body;
    detail = typeof error === "string" ? error :
      [error.code, error.type, error.message].filter((v) => typeof v === "string").join("; ");
  } catch {
    // Some compatible endpoints return plain text instead of JSON.
  }
  if (apiKey) detail = detail.replaceAll(apiKey, "[REDACTED]");
  detail = detail
    .replace(/Bearer\s+[^\s"'<>;,]+/gi, "Bearer [REDACTED]")
    .replace(/data:image\/[^;,\s]+;base64,[a-z0-9+/=]*/gi, "[IMAGE REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim().slice(0, 1000);
  return new Error(`Vision HTTP ${response.status} at ${label}${detail ? `: ${detail}` : ""}`);
}
