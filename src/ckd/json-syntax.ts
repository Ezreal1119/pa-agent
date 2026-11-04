/** Locate a native JSON.parse failure, including errors whose message has no offset. */
export function jsonErrorLocation(text: string, error: unknown): { line: number; column: number } {
  const message = error instanceof Error ? error.message : String(error);
  const coordinates = /\(line (\d+) column (\d+)\)/u.exec(message);
  if (coordinates) return { line: Number(coordinates[1]), column: Number(coordinates[2]) };
  const offset = /position (\d+)/u.exec(message);
  let position = offset ? Number(offset[1]) : 0;
  if (!offset) {
    // Used only for diagnostics; JSON.parse remains authoritative for acceptance.
    let cursor = 0;
    const fail = (): never => { throw cursor; };
    const whitespace = () => { while (/[\x20\t\r\n]/u.test(text[cursor] ?? "x")) cursor++; };
    const string = () => {
      if (text[cursor] !== '"') fail();
      cursor++;
      while (cursor < text.length) {
        const character = text[cursor]!;
        if (character === '"') { cursor++; return; }
        if (character.charCodeAt(0) < 32) fail();
        if (character === "\\") {
          cursor++;
          if (text[cursor] === "u") {
            cursor++;
            for (let digit = 0; digit < 4; digit++, cursor++) if (!/[0-9a-f]/iu.test(text[cursor] ?? "x")) fail();
            continue;
          }
          if (!/^["\\/bfnrt]$/u.test(text[cursor] ?? "")) fail();
        }
        cursor++;
      }
      fail();
    };
    const value = (): void => {
      whitespace();
      const character = text[cursor];
      if (character === '"') { string(); return; }
      if (character === "{" || character === "[") {
        const object = character === "{"; const close = object ? "}" : "]";
        cursor++; whitespace();
        if (text[cursor] === close) { cursor++; return; }
        for (;;) {
          if (object) { whitespace(); string(); whitespace(); if (text[cursor] !== ":") fail(); cursor++; }
          value(); whitespace();
          if (text[cursor] === close) { cursor++; return; }
          if (text[cursor] !== ",") fail();
          cursor++; whitespace();
        }
      }
      for (const literal of ["true", "false", "null"]) if (text.startsWith(literal, cursor)) { cursor += literal.length; return; }
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(cursor));
      if (number) { cursor += number[0].length; return; }
      fail();
    };
    try { value(); whitespace(); if (cursor !== text.length) fail(); position = cursor; }
    catch (location) { position = typeof location === "number" ? location : cursor; }
  }
  const preceding = text.slice(0, Math.min(position, text.length));
  return { line: preceding.split("\n").length, column: preceding.length - preceding.lastIndexOf("\n") };
}
