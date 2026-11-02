/**
 * Idempotency keys for HTTP: `idempotent(...)` is an `HttpMiddleware` that runs a request once per
 * key and answers a repeat with the stored response.
 *
 * Portable: no Node-only API. It hashes with Web Crypto. The stores live elsewhere:
 * `@arki/journal/http` (Postgres) and `@arki/kv/redis/idempotency` (Redis) implement
 * {@link ResponseCache}. This is a response cache for HTTP replay. It is not the journal's
 * command receipt, which commits with the business write.
 */
import type { StandardSchemaV1 } from '@arki/schema';
import type { Failure } from '@arki/failure';
import type { ContractLike, CoversFailures } from './contract.js';
import type { HttpMiddleware } from './engine.js';
import type { IdempotencyOwnerId } from './ids.js';
import type { RESPONSE_CACHE_BEGIN_FAILURES, RESPONSE_CACHE_FINISH_FAILURES, RESPONSE_CACHE_ABANDON_FAILURES } from './failures.js';
import { IDEMPOTENCY_FAILURES } from './failures.js';
export { IDEMPOTENCY_FAILURES, IdempotencyKeyRequired, IdempotencyKeyReused, IdempotencyInProgress, IdempotencyClaimUnconfirmed, IdempotencyWriteUnconfirmed, IdempotencyReleaseUnconfirmed, IdempotencyOwnershipLost, IdempotencyReplayInvalid, IdempotencyResponseUnavailable, IdempotencyRequestTooLarge, IdempotencyRequestUnreadable, IdempotencyHashUnavailable, RESPONSE_CACHE_BEGIN_FAILURES, RESPONSE_CACHE_FINISH_FAILURES, RESPONSE_CACHE_ABANDON_FAILURES, } from './failures.js';
export { idempotencyOwnerId } from './ids.js';
export type { IdempotencyOwnerId } from './ids.js';
/** A response as the cache keeps it. An exact type test locks `storedResponseSchema` to this type. */
export type StoredResponse = {
    status: number;
    headers: Record<string, string>;
    body: string;
};
/** Checks a {@link StoredResponse} read back from a cache: `parse(storedResponse, value)` from `@arki/schema`. */
export declare const storedResponse: StandardSchemaV1<StoredResponse>;
/** What `begin` found for a key. */
export type BeginResult = 
/** This request owns the key and must call `finish` or `abandon`. */
'started'
/** A finished request holds the key with the same fingerprint. Answer with `replay`. */
 | {
    readonly replay: StoredResponse;
}
/** Another request holds the key and has not finished. */
 | 'in-progress'
/** The key is held by a request with a different fingerprint. */
 | 'conflict';
/**
 * Where responses wait for a repeat. Every method is atomic in the store. `owner` is a token
 * that is unique per request. Unresolved reservations MUST NOT expire: elapsed time does not
 * prove application work never happened. `ttl` starts only when `finish` persists the replay.
 * Only reconciled operations may be abandoned. Store loss/eviction breaks this guarantee;
 * durable application receipts remain necessary for atomic business idempotency.
 */
export type ResponseCache = {
    begin(key: string, fingerprint: string, owner: IdempotencyOwnerId): Promise<BeginResult | ReturnType<(typeof RESPONSE_CACHE_BEGIN_FAILURES)[number]>>;
    /** Persist the response and start replay retention (milliseconds). Confirm ownership or return its failure. */
    finish(key: string, owner: IdempotencyOwnerId, response: StoredResponse, ttl: number): Promise<void | ReturnType<(typeof RESPONSE_CACHE_FINISH_FAILURES)[number]>>;
    /** Release only after reconciliation proves repetition safe. A no-op for an absent/different owner. */
    abandon(key: string, owner: IdempotencyOwnerId): Promise<void | ReturnType<(typeof RESPONSE_CACHE_ABANDON_FAILURES)[number]>>;
};
export type IdempotentOptions<Routes extends readonly ContractLike[] = readonly ContractLike[], ScopeResult extends string | undefined | Failure = string | undefined> = {
    readonly cache: ResponseCache;
    /**
     * Who is asking: a user id, a tenant plus user, an API key id. Runs for each listed request.
     * Return `undefined` for an unauthenticated request: it skips the cache entirely, so it never
     * replays, and the handler's own authentication answers it. The key is scoped by this value,
     * so two callers can use the same key without meeting. Returned canonical failures stop
     * execution; every listed route must declare their inferred definitions. Observe `req.signal`
     * to stop pending work when the request is cancelled.
     */
    readonly scope: (req: Request) => ScopeResult | Promise<ScopeResult>;
    /** Canonical route descriptors; each must list every IDEMPOTENCY_FAILURES definition. Paths include any mount prefix. */
    readonly routes: Routes;
    /** Default `Idempotency-Key`. */
    readonly header?: string;
    /** Replay retention after confirmed finish, in milliseconds. Pending reservations do not expire. */
    readonly ttl: number;
    /** Default 1 MiB. Larger requests are refused; larger responses retain an unresolved reservation. */
    readonly maxBodyBytes?: number;
    /** Response headers a replay carries, lower case. Default `content-type`, `location`, `etag`. */
    readonly replayHeaders?: readonly string[];
};
/**
 * Run each listed request once per key while its reservation/replay is retained.
 * Configure after authentication and CORS. Pending claims never expire. Every bounded response,
 * including 5xx/409/429, is stored; the replay TTL starts at confirmed persistence.
 * After handler dispatch, no status, exception or cache fault proves repetition safe. The
 * middleware never abandons that reservation. Unreplayable responses return a typed failure;
 * reconciliation must determine the application outcome before an operator releases the key.
 * Oversized requests are refused before execution. Store loss and replay expiry are outside
 * this cache's protection; use transactional business receipts for durable idempotency.
 */
export declare function idempotent<const Routes extends readonly ContractLike[], ScopeResult extends string | undefined | Failure = string | undefined>(options: IdempotentOptions<Routes, ScopeResult> & {
    readonly routes: {
        readonly [Key in keyof Routes]: Routes[Key] & CoversFailures<NoInfer<Routes[Key]>, ReturnType<(typeof IDEMPOTENCY_FAILURES)[number]> | NoInfer<Extract<ScopeResult, Failure>>>;
    };
}): HttpMiddleware;
//# sourceMappingURL=idempotency.d.ts.map