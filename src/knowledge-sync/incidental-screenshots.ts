/** Narrow screenshot-only exceptions, corroborated by the same region's native
 * instructions AND readable transcription. No new facts or inferred labels. */
export type IncidentalDecision = { kind: "incidental"; reason: string; quote: string };
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const critical = /\b(?:warning|caution|safety|certification|compliance|voltage|rating|capacity|pin|pogopin|password|serial|specification|model|firmware|revision|version|selected|required|target|highlighted|button|toggle|instructions?|procedures?|steps?|operations?|controls?|parameters?|values?|paragraph|caption|privacy|permissions?|personal|security|authentication|credentials|erase|delete|barcode|qr|rfid)\b|\b\d+(?:\.\d+)?\s*(?:mAh|mA|kHz|MHz|GHz|GB|MB|mm|cm|V|A|W)\b|警告|安全|参数|型号|引脚|电压|电流/i;
export function incidentalScreenshot(
  issue: string, transcription: string, nativeText: string,
): IncidentalDecision | undefined {
  if (!nativeText.trim() || critical.test(issue)) return;
  const native = flat(nativeText), readable = flat(transcription);
  const anchor = (pattern: RegExp) => {
    const quote = pattern.exec(native)?.[0];
    return quote && readable.toLowerCase().includes(quote.toLowerCase()) ? quote : undefined;
  };
  const onlyGenericSelections = (pattern: RegExp) => {
    const selections = native.match(/\b(?:select|choose)\b[^.;]*/gi) ?? [];
    return selections.length > 0 && selections.every(selection => pattern.test(selection.trim()));
  };
  let quote: string | undefined;
  if (/\bstatus[ -]bar icons?\b/i.test(issue) && /\b(?:screenshot|upper right|beside)\b/i.test(issue) &&
      /(?:Data|Date)\s*&\s*time/i.test(native) &&
      !/\b(?:icons?|battery|signal|status[ -]bar|bluetooth|wi[ -]?fi|charging)\b/i.test(native)) {
    quote = anchor(/Touch to set Time\./i);
    if (quote) return { kind: "incidental", quote, reason: "Only incidental status-bar icons in a date/time example screenshot are unreadable; the same-page date/time instructions are retained." };
  }
  if (/\bAvailable devices\b/i.test(issue) && /\b(?:further|additional|another|last|bottom|extra)\b/i.test(issue) &&
      /\b(?:entry|device name)\b/i.test(issue) && /\b(?:bottom|navigation bar|overlay|obscured)\b/i.test(issue) &&
      onlyGenericSelections(/^Select the Bluetooth device you want to connect to$/i) &&
      !/\b(?:pair|connect|choose|select)\s+(?:to\s+|with\s+)?["“']/i.test(native)) {
    quote = anchor(/Select the Bluetooth device you want to connect to\./i);
    if (quote) return { kind: "incidental", quote, reason: "Only an extra unselected discovery-list example name is obscured; the complete generic device-selection instruction is retained." };
  }
  if (/\bapp[ -]selection list\b/i.test(issue) && /\b(?:final|last|bottom)\b/i.test(issue) &&
      /\blabel\b/i.test(issue) && /\b(?:icon|entry)\b/i.test(issue) &&
      onlyGenericSelections(/^Select the app you want to associate with$/i) &&
      !/\b(?:choose|select|associate)\s+(?:with\s+)?["“']/i.test(native)) {
    quote = anchor(/Select the app you want to associate with\./i);
    if (quote) return { kind: "incidental", quote, reason: "Only the final unselected app-picker example label is clipped; the generic app-selection procedure is retained." };
  }
  if (/\bUSB Preferences\b/i.test(issue) && /\b(?:bottom[ -]edge|bottom edge)\b/i.test(issue) &&
      /\b(?:screenshot|image)\b/i.test(issue) && /\bdata trans\b/i.test(issue) && !/\bPTP\b/i.test(issue) &&
      /(?:◉\s*PTP|PTP\s*\(selected)/i.test(transcription)) {
    quote = anchor(/Pull down the status bar to open the notification panel and select PTP in USB Preferences to transfer pictures to computer[;.]/i);
    if (quote) return { kind: "incidental", quote, reason: "Only a different option at the bottom of a USB example screenshot is clipped; the selected PTP control and complete PTP instruction are retained." };
  }
}
