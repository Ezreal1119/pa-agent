export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export class ImageInputError extends Error { readonly status = 400; }
/** Read dimensions without decoding untrusted images. The provider validates full image data. */
export function inspectImage(bytes: Buffer): { width: number; height: number; mimeType: string } {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ImageInputError("Image must contain 1 byte to 10 MiB.");
  let width = 0, height = 0, mimeType = "";
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(8) === 13) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mimeType = "image/png";
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = "image/jpeg";
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker !== undefined && [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height || width > 20000 || height > 20000 || width * height > 40_000_000) throw new ImageInputError("Use a valid PNG/JPEG image, at most 40 megapixels and 20000 pixels per side.");
  return { width, height, mimeType };
}
