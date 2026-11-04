import { createHash } from "node:crypto";
import type { Candidate } from "./types.js";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function scrub(text: string): string {
  return text
    .replace(/\b(?:Bearer\s+\S+|(?:sk|AKIA)[-_A-Za-z0-9]{16,})/gi, "[凭据已遮盖]")
    .replace(/(?:api[_ -]?key|secret|password|密码|token)\s*[=:：]\s*["']?[^\s,"'；;]+/gi, "[凭据已遮盖]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已遮盖]")
    .replace(/https?:\/\/[^\s<>"'）)]+/gi, "[链接已遮盖]")
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|opt|root|var|tmp|private)\/)[^\s,"'；;）)]+/g, "[路径已遮盖]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[地址已遮盖]")
    .replace(/\+\d[\d ()-]{7,}\d|\b\d{2,4}[- ]\d{6,10}\b/g, "[电话号码已遮盖]")
    .replace(/\b(?:\+\d{1,3}[- ]?)?1[3-9]\d{9}\b|\b\d{15,18}[0-9Xx]?\b/g, "[号码已遮盖]")
    .replace(/(?:客户名称|项目名称|联系人|姓名|工号|订单号|合同号|公司名称|联系电话|收件地址)\s*[:：=]\s*[^\n，,。；;]+/g, "[身份或业务标识已遮盖]")
    .replace(/[A-Za-z0-9_=-]{32,}/g, "[内部标识已遮盖]");
}
export function safeCandidate(candidate: Candidate, originals: string[], publicProducts: Set<string>) {
  const text = [candidate.question, ...candidate.products, ...candidate.versions, candidate.explanation, candidate.evidence].join("\n");
  const normalized = text.normalize("NFKC");
  if (scrub(normalized) !== normalized || /\p{Cf}/u.test(text) || /[\u0000-\u001f\u007f]/u.test(text.replace(/\n/g, "")) ||
      /[「」“”"`]|\[(?:.*已遮盖|REDACTED).*\]|(?:用户|客户|项目|公司|联系人|订单|合同)(?:名|名称|编号)|(?:原问题|原回答|原文|用户说|用户问)|\b(?:case-\d+|[a-f0-9]{32,})\b|\.(?:md|jsonl?|docx?|pptx?|xlsx?|pdf|txt|zip|png|jpe?g|webp)\b|\b[a-z0-9.-]+\.(?:com|cn|net|org|local|internal|io)\b|[\p{L}\p{N}_.-]+[/\\][\p{L}\p{N}_.-]+[/\\][\p{L}\p{N}_.-]+/iu.test(text)) return false;
  if (!/[？?]$/.test(candidate.question) || !/\p{Script=Han}/u.test(candidate.question)) return false;
  if ([...candidate.question].length > 120 || /^(?:该|这个|上述|前述|这款|此)/u.test(candidate.question)) return false;
  if (candidate.products.some(p => !publicProducts.has(p.toLowerCase()))) return false;
  const canonical = (v: string) => v.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase();
  const q = canonical(candidate.question);
  // Even a short question must be generalized rather than copied verbatim.
  if (originals.some(raw => canonical(raw).includes(q))) return false;
  // Reject long copied source spans, including those hidden in explanations.
  const output = canonical(text);
  for (const raw of originals) {
    const source = canonical(raw);
    for (let at = 0; at + 24 <= source.length; at += 4) if (output.includes(source.slice(at, at + 24))) return false;
  }
  return true;
}
export function questionKey(candidate: Pick<Candidate, "category" | "question" | "products" | "versions">) {
  return digest(JSON.stringify([candidate.category, candidate.question.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase(), [...candidate.products].sort(), [...candidate.versions].sort()]));
}
