/**
 * Byte helpers shared by the portable entries (`idempotency`, `webhooks`). Internal: not exported.
 */
export declare const toHex: (bytes: ArrayBuffer | Uint8Array) => string;
/**
 * Reads a body, but stops once it passes `limit` bytes: `undefined` then, and the rest stays unread.
 * `Content-Length` can be absent (chunked) or wrong, so only counting the bytes keeps the cap real.
 */
export declare const readCapped: (body: ReadableStream<Uint8Array> | null, limit: number) => Promise<Uint8Array<ArrayBuffer> | undefined>;
export declare const toBase64: (bytes: Uint8Array) => string;
export declare const fromBase64: (text: string) => Uint8Array<ArrayBuffer>;
//# sourceMappingURL=bytes.d.ts.map