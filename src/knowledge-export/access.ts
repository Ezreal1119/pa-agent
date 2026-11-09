import { createHash, timingSafeEqual } from "node:crypto";

export interface ExportToken { id: string; token: string; }
const digest = (value: string) => createHash("sha256").update(value).digest();

/** Dedicated, read-only credentials; never substitutes for a Web or Bridge login. */
export class ExportAccess {
  private readonly readers: { id: string; digest: Buffer }[];
  constructor(tokens: ExportToken[]) {
    const ids = new Set<string>();
    const hashes = new Set<string>();
    if (!Array.isArray(tokens) || tokens.length > 100) throw new Error("KNOWLEDGE_EXPORT_TOKENS must be an array of at most 100 readers.");
    this.readers = tokens.map(reader => {
      if (!reader || typeof reader.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(reader.id)
        || typeof reader.token !== "string" || !/^[\x21-\x7e]{32,256}$/.test(reader.token)
        || Object.keys(reader).some(key => !["id", "token"].includes(key))) {
        throw new Error("Each export reader requires an id and a dedicated 32..256-character printable token without spaces.");
      }
      const expected = digest(reader.token);
      const hash = expected.toString("hex");
      if (ids.has(reader.id) || hashes.has(hash)) throw new Error("Export reader ids and tokens must be unique.");
      ids.add(reader.id); hashes.add(hash);
      return { id: reader.id, digest: expected };
    });
  }
  get configured() { return this.readers.length > 0; }
  authenticated(header: string | undefined) {
    const token = header?.match(/^Bearer ([\x21-\x7e]{32,256})$/i)?.[1];
    if (!token) return false;
    const received = digest(token);
    let matched = false;
    for (const reader of this.readers) matched = timingSafeEqual(reader.digest, received) || matched;
    return matched;
  }
}

export function exportTokens(env: Record<string, string | undefined>): ExportToken[] {
  if (!env.KNOWLEDGE_EXPORT_TOKENS?.trim()) return [];
  try {
    const value: unknown = JSON.parse(env.KNOWLEDGE_EXPORT_TOKENS);
    if (!Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error("KNOWLEDGE_EXPORT_TOKENS must be a JSON array of {id, token} readers."); }
}
