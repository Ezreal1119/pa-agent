/** Decode Office XML before inspecting it; ZIP entries may contain UTF-16 metadata. */
export function decodeOfficeXml(data: Uint8Array): string {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts(0xff, 0xfe, 0, 0) || starts(0, 0, 0xfe, 0xff)) throw new Error("UTF-32 Office XML is not supported.");
  let encoding = "utf-8";
  if (starts(0xff, 0xfe) || starts(0x3c, 0, 0x3f, 0)) encoding = "utf-16le";
  else if (starts(0xfe, 0xff) || starts(0, 0x3c, 0, 0x3f)) encoding = "utf-16be";
  // Fatal decoding avoids replacing malformed bytes with U+FFFD and hiding unsafe markup.
  // BOM/signature takes precedence over stale declarations in Office customXml parts.
  return new TextDecoder(encoding, { fatal: true }).decode(data);
}
