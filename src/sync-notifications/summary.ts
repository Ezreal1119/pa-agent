// Notifications use source-backed complete statements. Never invent a business
// update from an operational log or cut a sentence to fit the message budget.
const technical = /(?:https?:\/\/|[A-Za-z]:\\|(?:^|\s)[./~]*[\p{L}\p{N}_.-]+[/\\]|[\p{L}\p{N}_.-]+[/\\][\p{L}\p{N}_.-]+|(?:^|\s)\/[\p{L}\p{N}_.-]+|[\w.-]+[ _-]\d{8,14}\b|\b(?:index|SKILL|SYNC_PROMPT)\.md\b|\.(?:jsonl?|md)\b|Current Source Coverage|source[_ ]?(?:Rows?|Key)|oldPaths?|newPath|manifest|路径|节点|覆盖表|索引键|行改为键|\bshared\b|\bOriginal\b|\bConverted\b|original removed|successful sync|文件转换|转换完成|已转换|原件.{0,10}(?:清理|删除|移除)|(?:清理|删除|移除).{0,10}原件|临时文件|暂存|后端校验|备份|原子写入)/iu;
const blocker = /尚未|未解决|未确认|待(?:核对|确认|澄清|补充|解决)|仍需|仍有.{0,20}(?:冲突|差异|疑问|歧义)|无法(?:确定|确认)|(?:冲突|差异).{0,12}(?:未|待)|(?:未|待).{0,12}(?:冲突|差异)/u;
const change = /新增|增加|减少|更新|升级|降级|提升|降低|扩展|变更|改为|改用|更正|修改|优化|修复|支持|补充|修正|纠正|调整|替换|保留|删除|移除|注明|明确|未改|未变|无变化|一致/u;

function parts(text: string, comma = false, includeTail = true) {
  const close: Record<string, string> = { "（": "）", "(": ")", "[": "]", "【": "】", "「": "」", "『": "』", "“": "”", "‘": "’" };
  const stack: string[] = [], result: string[] = [];
  let current = "";
  for (const char of text) {
    if (close[char]) stack.push(close[char]);
    else if (Object.values(close).includes(char)) {
      if (stack.pop() !== char) return []; // Do not send malformed quoted fragments.
    }
    if (!stack.length && (comma ? /[，,]/u : /[。；;\n]/u).test(char)) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else current += char;
  }
  if (includeTail && !stack.length && current.trim()) result.push(current.trim());
  return result;
}

function checkText(text: string) {
  // Common specification pairs and calendar dates are facts, not file paths.
  return text.replace(/\b\d{4}\/\d{1,2}\/\d{1,2}\b/g, "日期")
    .replace(/\b(?:F\s*\/\s*FS|RAM\s*\/\s*ROM|NFC\s*\/\s*RFID|IP\d{2}\s*\/\s*IP\d{2}|\dG\s*\/\s*\dG)\b/gi, "规格组合");
}

export function briefSyncSummary(value?: string): string[] {
  if (!value) return [];
  // Bound legacy input work; a cut trailing sentence is never treated as complete.
  const overflow = value.length > 8192;
  const source = value.slice(0, 8192).replace(/\r\n?/g, "\n")
    .replace(/[（(][^（）()\n]*(?:暂存|后端校验|staged|pending publication)[^（）()\n]*[）)]/gi, "")
    .replace(/[①-⑳]/g, "\n")
    .replace(/、(?=(?:未解决|未修改|未改|尚未|待确认|待核对|新增|更新|补充))/g, "；");
  const candidates: { text: string; blocker: boolean }[] = [];
  for (const sentence of parts(source, false, !overflow)) {
    if (sentence.length > 1600) continue;
    // Legacy reports may mix a path clause with a useful following statement.
    // Split at commas only for this recovery; ordinary business sentences retain
    // their qualifiers, negation and uncertainty in the same statement.
    const statements = technical.test(checkText(sentence)) ? parts(sentence, true) : [sentence];
    for (let text of statements) {
      if (technical.test(checkText(text))) continue;
      text = text.replace(/^(?:[-•]\s*|\d+[.)、]\s*)/, "")
        .replace(/^(?:(?:按|根据|按照)管理员(?:决定|要求|反馈)|更新摘要|同步摘要)[：:,，\s]*/u, "")
        .replace(/^(?:并且|以及|同时|并)\s*/u, "")
        .replace(/^(?:补充说明)?格式(?:替换|调整)(?=未(?:改|修改)规格)/u, "")
        .replace(/未改规格值/g, "未修改规格参数")
        .replace(/客显(?!示)(?:屏)?/g, "客户显示屏").replace(/后摄(?:像头)?/g, "后置摄像头")
        .replace(/\bF\s+vs\s+FS\b/gi, "F 与 FS")
        .replace(/[\u0000-\u001f\u007f<>\[\]*`@]/g, " ").replace(/\s+/g, " ").trim();
      // Keep grounded, useful Chinese statements, not headings or generic success.
      if (!/\p{Script=Han}/u.test(text) || text.length < 5 || [...text].length > 140 || /[：:、，,或与及和…]$/.test(text) ||
          /\bHub\b/i.test(text) || /^(?:已入库|同步完成|同步成功|资料已更新|已更新知识库)[。！!\s]*$/.test(text) ||
          !(blocker.test(text) || change.test(text))) continue;
      if (!candidates.some(item => item.text === text)) candidates.push({ text, blocker: blocker.test(text) });
    }
  }
  // Reserve room for an unresolved issue even when several updates precede it.
  const update = candidates.find(item => !item.blocker), issue = candidates.find(item => item.blocker);
  if (update && issue) return [update.text, issue.text];
  return candidates.slice(0, 2).map(item => item.text);
}
