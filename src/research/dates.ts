// Only explicit publication labels in the page header are used. This is a
// conflict check, not a guess from URL dates, signatures or event sentences.
export function publicationDates(
  content: string,
): { day: string; quote: string }[] {
  const dates: { day: string; quote: string }[] = [];
  for (const line of content.slice(0, 3500).split(/\r?\n/)) {
    const plain = line.replace(/\\/g, "");
    const label =
      /(?:发布日期|发布时间|发布于|publication date|published(?:\s+on)?)[\s:：|]*/i.exec(
        plain,
      );
    if (!label) continue;
    const tail = plain.slice(
      label.index + label[0].length,
      label.index + label[0].length + 90,
    );
    const numeric = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.exec(tail);
    let value: string | undefined;
    if (numeric)
      value = `${numeric[1]}-${numeric[2]!.padStart(2, "0")}-${numeric[3]!.padStart(2, "0")}`;
    else {
      const english =
        /(?:\d{1,2}\s+[A-Za-z]{3,9}\s+20\d{2}|[A-Za-z]{3,9}\s+\d{1,2},?\s+20\d{2})/.exec(
          tail,
        );
      if (english && Number.isFinite(Date.parse(english[0] + " UTC")))
        value = new Date(english[0] + " UTC").toISOString().slice(0, 10);
    }
    if (
      value &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value &&
      !dates.some((d) => d.day === value)
    )
      dates.push({ day: value, quote: line.slice(0, 500) });
  }
  return dates;
}
