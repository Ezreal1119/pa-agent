import type { ReviewSettings } from "./types.js";
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localParts(time: number, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); formatters.set(zone, formatter); }
  const p = Object.fromEntries(formatter.formatToParts(time).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export function nextDue(settings: ReviewSettings, now: number) {
  if (!settings.enabled) return undefined;
  for (let at = Math.floor(now / 60000) * 60000 + 60000; at < now + 4 * 86400000; at += 60000) if (localParts(at, settings.timeZone).time === settings.time) return new Date(at).toISOString();
  throw new Error("Cannot resolve review schedule");
}
const addDay = (date: string, amount: number) => new Date(Date.parse(date + "T12:00:00Z") + amount * 86400000).toISOString().slice(0, 10);
export function previousDayRange(now: number, zone: string) {
  const today = localParts(now, zone).date, yesterday = addDay(today, -1);
  const boundary = (date: string) => {
    const center = Date.parse(date + "T00:00:00Z"); let low = center - 2 * 86400000, high = center + 2 * 86400000;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (localParts(mid, zone).date < date) low = mid + 1; else high = mid; }
    return new Date(low).toISOString();
  };
  return { from: boundary(yesterday), to: boundary(today), date: today };
}
