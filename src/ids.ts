import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';

/** Request correlation identity; supplied header values retain their existing format. */
export const requestId = defineId('', { kind: 'http.request', format: 'uuid' });
export type RequestId = IdOf<typeof requestId>;

/** One acquisition of an HTTP idempotency key, distinct from request correlation. */
export const idempotencyOwnerId = defineId('', { kind: 'http.idempotency-owner', format: 'uuid' });
export type IdempotencyOwnerId = IdOf<typeof idempotencyOwnerId>;
