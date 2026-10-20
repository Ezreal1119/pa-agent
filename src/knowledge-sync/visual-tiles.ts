/** Full-size overlapping regions, with the final region aligned to the edge. */
export function tileOffsets(length: number): number[] {
  if (!Number.isSafeInteger(length) || length < 1)
    throw new Error("Invalid image dimension.");
  const size = 1800, step = 1680;
  const offsets = [0];
  let current = 0;
  while (current + size < length) {
    current = Math.min(current + step, length - size);
    offsets.push(current);
  }
  return offsets;
}
