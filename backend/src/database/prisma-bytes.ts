/**
 * Prisma 7 requires bytes backed by an ArrayBuffer. Node's Buffer may be
 * backed by an ArrayBufferLike, so copy it at the database boundary.
 */
export function prismaBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}
