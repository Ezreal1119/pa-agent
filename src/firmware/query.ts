export interface FirmwareQuery { model: string; date: string; index: string; }

export function validateQuery(value: unknown): FirmwareQuery {
  const q = value as FirmwareQuery;
  if (!q || typeof q !== "object" || Array.isArray(q) || Object.keys(q).sort().join(",") !== "date,index,model" || typeof q.model !== "string" || !/^SQ[A-Z0-9]{1,30}$/i.test(q.model) || typeof q.date !== "string" || !/^\d{6}$/.test(q.date) || typeof q.index !== "string" || !/^\d{2}$/.test(q.index)) throw new Error("固件查询必须包含 SQ 型号、六位日期和两位 index。");
  const year = 2000 + Number(q.date.slice(0, 2)), month = Number(q.date.slice(2, 4)), day = Number(q.date.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error("固件日期无效。");
  return { model: q.model.toUpperCase(), date: q.date, index: q.index };
}

export function extractedQuery(value: unknown, text: string): FirmwareQuery | null {
  const q = value as Record<string, unknown>;
  if (!q || typeof q !== "object" || Array.isArray(q) || Object.keys(q).sort().join(",") !== "date,index,model") throw new Error("固件条件提取格式无效。");
  if ([q.model, q.date, q.index].some(v => v === null)) return null;
  const query = validateQuery(q);
  // Values must occur in the request. Chinese adjacent text is a valid boundary;
  // S01 and digits embedded in a model cannot masquerade as the requested index.
  for (const token of [query.model, query.date, query.index]) {
    if (!new RegExp("(?<![A-Za-z0-9])" + token + "(?![A-Za-z0-9])", "i").test(text)) throw new Error("AI 提取的固件条件不在用户原文中。");
  }
  return query;
}

export function matchesQuery(filename: string, q: FirmwareQuery): boolean {
  return filename.split("_", 1)[0]?.toUpperCase() === q.model && new RegExp("_" + q.date + "_" + q.index + "(?=_|\\.zip$)", "i").test(filename);
}
