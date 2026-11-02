/**
 * Byte helpers shared by the portable entries (`idempotency`, `webhooks`). Internal: not exported.
 */

export const toHex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * Reads a body, but stops once it passes `limit` bytes: `undefined` then, and the rest stays unread.
 * `Content-Length` can be absent (chunked) or wrong, so only counting the bytes keeps the cap real.
 */
export const readCapped = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    size += chunk.value.byteLength;
    if (size > limit) {
      // Not awaited: a cloned body is one branch of a tee, and its cancel settles only once the
      // other branch, still in use by the handler or the client, is done too.
      void reader.cancel().catch(() => null);
      return undefined;
    }
    chunks.push(chunk.value);
    chunk = await reader.read();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of chunks) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
};

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x80_00) binary += String.fromCodePoint(...bytes.subarray(i, i + 0x80_00));
  return btoa(binary);
};

export const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0;
  return bytes;
};
