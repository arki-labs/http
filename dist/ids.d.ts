import type { IdOf } from '@arki/contracts';
/** Request correlation identity; supplied header values retain their existing format. */
export declare const requestId: import("@arki/contracts").BrandedIdDeclaration<"", "http.request">;
export type RequestId = IdOf<typeof requestId>;
/** One acquisition of an HTTP idempotency key, distinct from request correlation. */
export declare const idempotencyOwnerId: import("@arki/contracts").BrandedIdDeclaration<"", "http.idempotency-owner">;
export type IdempotencyOwnerId = IdOf<typeof idempotencyOwnerId>;
//# sourceMappingURL=ids.d.ts.map