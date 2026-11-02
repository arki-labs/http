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
import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { ContractLike, CoversFailures } from './contract.js';
import type { HttpMiddleware } from './engine.js';
import type { IdempotencyOwnerId } from './ids.js';
import { idempotencyOwnerId } from './ids.js';
import { storedResponseSchema } from './stored-response.js';
import { observeHttp } from './telemetry.js';
import { fromBase64, readCapped, toBase64, toHex } from './bytes.js';
import { HTTP_ERROR_CODES, HttpConfigError, orThrowHttp } from './error.js';
import type { RESPONSE_CACHE_BEGIN_FAILURES, RESPONSE_CACHE_FINISH_FAILURES, RESPONSE_CACHE_ABANDON_FAILURES } from './failures.js';
import {
  IDEMPOTENCY_FAILURES,
  IdempotencyInProgress,
  IdempotencyKeyRequired,
  IdempotencyKeyReused,
  IdempotencyClaimUnconfirmed,
  IdempotencyWriteUnconfirmed,
  IdempotencyReplayInvalid,
  IdempotencyResponseUnavailable,
  IdempotencyRequestTooLarge,
  IdempotencyRequestUnreadable,
  IdempotencyHashUnavailable,
  RequestCancelled,
} from './failures.js';

export {
  IDEMPOTENCY_FAILURES,
  IdempotencyKeyRequired,
  IdempotencyKeyReused,
  IdempotencyInProgress,
  IdempotencyClaimUnconfirmed,
  IdempotencyWriteUnconfirmed,
  IdempotencyReleaseUnconfirmed,
  IdempotencyOwnershipLost,
  IdempotencyReplayInvalid,
  IdempotencyResponseUnavailable,
  IdempotencyRequestTooLarge,
  IdempotencyRequestUnreadable,
  IdempotencyHashUnavailable,
  RESPONSE_CACHE_BEGIN_FAILURES,
  RESPONSE_CACHE_FINISH_FAILURES,
  RESPONSE_CACHE_ABANDON_FAILURES,
} from './failures.js';

export { idempotencyOwnerId } from './ids.js';
export type { IdempotencyOwnerId } from './ids.js';

/** A response as the cache keeps it. An exact type test locks `storedResponseSchema` to this type. */
export type StoredResponse = { status: number; headers: Record<string, string>; body: string };

/** Checks a {@link StoredResponse} read back from a cache: `parse(storedResponse, value)` from `@arki/schema`. */
export const storedResponse: StandardSchemaV1<StoredResponse> = storedResponseSchema;

/** What `begin` found for a key. */
export type BeginResult =
  /** This request owns the key and must call `finish` or `abandon`. */
  | 'started'
  /** A finished request holds the key with the same fingerprint. Answer with `replay`. */
  | { readonly replay: StoredResponse }
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
  begin(key: string, fingerprint: string, owner: IdempotencyOwnerId): Promise<
    BeginResult | ReturnType<(typeof RESPONSE_CACHE_BEGIN_FAILURES)[number]>
  >;
  /** Persist the response and start replay retention (milliseconds). Confirm ownership or return its failure. */
  finish(key: string, owner: IdempotencyOwnerId, response: StoredResponse, ttl: number): Promise<
    void | ReturnType<(typeof RESPONSE_CACHE_FINISH_FAILURES)[number]>
  >;
  /** Release only after reconciliation proves repetition safe. A no-op for an absent/different owner. */
  abandon(key: string, owner: IdempotencyOwnerId): Promise<
    void | ReturnType<(typeof RESPONSE_CACHE_ABANDON_FAILURES)[number]>
  >;
};

export type IdempotentOptions<
  Routes extends readonly ContractLike[] = readonly ContractLike[],
  ScopeResult extends string | undefined | Failure = string | undefined,
> = {
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

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_REPLAY_HEADERS = ['content-type', 'location', 'etag'] as const;
const MAX_KEY_LENGTH = 255;
const textEncoder = new TextEncoder();

/** Web Crypto is a foreign boundary: preserve its receiver and validate its digest protocol. */
const sha256 = async (data: Uint8Array<ArrayBuffer> | string) => {
  try {
    const crypto: unknown = Reflect.get(globalThis, 'crypto');
    if (typeof crypto !== 'object' || crypto === null) return IdempotencyHashUnavailable();
    const subtle: unknown = Reflect.get(crypto, 'subtle');
    if (typeof subtle !== 'object' || subtle === null) return IdempotencyHashUnavailable();
    const digest: unknown = Reflect.get(subtle, 'digest');
    if (typeof digest !== 'function') return IdempotencyHashUnavailable();
    const result: unknown = await Reflect.apply(digest, subtle, [
      'SHA-256',
      typeof data === 'string' ? textEncoder.encode(data) : data,
    ]);
    if (!(result instanceof ArrayBuffer)) {
      return UnexpectedDefect({ cause: new TypeError('SHA-256 must return a 32-byte ArrayBuffer.') });
    }
    const bytes = new Uint8Array(result);
    if (bytes.byteLength !== 32) {
      return UnexpectedDefect({ cause: new TypeError('SHA-256 must return a 32-byte ArrayBuffer.') });
    }
    return toHex(bytes);
  } catch (error) {
    return UnexpectedDefect({ cause: error });
  }
};

/** `'POST /orders/:id'` to a method and an anchored path pattern. */
const compileRoute = (route: ContractLike) => {
  const path = route.path
    .split('/')
    .map(segment => {
      if (segment.startsWith(':')) return segment.endsWith('?') ? '(?:/[^/]+)?' : '/[^/]+';
      return segment === '' ? '' : `/${segment.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)}`;
    })
    .join('');
  return { method: route.method, path: new RegExp(`^${path === '' ? '/' : path}/?$`), failures: route.failures ?? [] };
};

/** Method + path + sorted query + body hash, hashed. Two requests share a fingerprint only when they ask for the same thing. */
const fingerprintOf = async (req: Request, url: URL, body: Uint8Array<ArrayBuffer>) => {
  const query = [...url.searchParams].toSorted(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  const bodyHash = await sha256(body);
  if (req.signal.aborted) return RequestCancelled();
  if (isFailure(bodyHash)) return bodyHash;
  return sha256(`${req.method}\n${url.pathname}\n${JSON.stringify(query)}\n${bodyHash}`);
};

const replayResponse = (stored: StoredResponse): Response => {
  const headers = new Headers(stored.headers);
  headers.set('idempotent-replayed', 'true');
  const bodyless = stored.status === 204 || stored.status === 205 || stored.status === 304;
  return new Response(bodyless ? null : fromBase64(stored.body), { status: stored.status, headers });
};

/** Release unread response resources without granting permission to repeat application work. */
function discardResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => null);
  } catch {
    // A foreign/locked stream may refuse cancellation; the reservation remains held.
  }
}

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
export function idempotent<
  const Routes extends readonly ContractLike[],
  ScopeResult extends string | undefined | Failure = string | undefined,
>(
  options: IdempotentOptions<Routes, ScopeResult> & {
    readonly routes: {
      readonly [Key in keyof Routes]: Routes[Key] &
        CoversFailures<
          NoInfer<Routes[Key]>,
          ReturnType<(typeof IDEMPOTENCY_FAILURES)[number]> | NoInfer<Extract<ScopeResult, Failure>>
        >;
    };
  },
): HttpMiddleware;
export function idempotent(options: IdempotentOptions<readonly ContractLike[], string | undefined | Failure>): HttpMiddleware {
  const { cache, scope, ttl } = options;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.invalidContract,
      message: 'Idempotency replay retention must be a positive safe integer in milliseconds.',
      remediation: 'Configure a finite positive integer ttl.',
    });
  }
  const headerName = options.header ?? 'Idempotency-Key';
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.invalidContract,
      message: 'Idempotency body limit must be a positive safe integer in bytes.',
      remediation: 'Configure a finite positive integer maxBodyBytes.',
    });
  }
  const allowed = new Set((options.replayHeaders ?? DEFAULT_REPLAY_HEADERS).map(name => name.toLowerCase()));
  const patterns = options.routes.map(route => {
    if (!IDEMPOTENCY_FAILURES.every(failure => route.failures?.some(candidate => candidate.code === failure.code))) {
      throw new HttpConfigError({
        code: HTTP_ERROR_CODES.invalidContract,
        message: 'Every idempotent route must declare IDEMPOTENCY_FAILURES.',
        remediation: 'List IDEMPOTENCY_FAILURES on each protected route contract.',
      });
    }
    return compileRoute(route);
  });

  return async (req, next) => {
    const url = new URL(req.url);
    const pattern = patterns.find(candidate => candidate.method === req.method && candidate.path.test(url.pathname));
    if (pattern === undefined) return next(req);

    return observeHttp('http.idempotency', async () => {
      // Read afresh across awaits: cancellation can change while foreign work runs.
      const cancelled = () => req.signal.aborted;
      if (cancelled()) return orThrowHttp(RequestCancelled(), IDEMPOTENCY_FAILURES);
      // Callbacks may come from JavaScript; validate their result before it can scope a key.
      let principal: unknown;
      try {
        principal = await scope(req);
      } catch (error) {
        return orThrowHttp(
          cancelled() ? RequestCancelled() : UnexpectedDefect({ cause: error }),
          IDEMPOTENCY_FAILURES,
        );
      }
      if (cancelled()) return orThrowHttp(RequestCancelled(), IDEMPOTENCY_FAILURES);
      if (isFailure(principal)) return orThrowHttp(principal, pattern.failures);
      if (principal === undefined) return next(req);
      if (typeof principal !== 'string') {
        return orThrowHttp(
          UnexpectedDefect({ cause: new TypeError('Idempotency scope returned an invalid result.') }),
          IDEMPOTENCY_FAILURES,
        );
      }

      const supplied = req.headers.get(headerName)?.trim();
      if (supplied === undefined || supplied === '' || supplied.length > MAX_KEY_LENGTH) {
        orThrowHttp(IdempotencyKeyRequired(), IDEMPOTENCY_FAILURES);
      }

      const declared = Number(req.headers.get('content-length') ?? 0);
      if (declared > maxBodyBytes) return orThrowHttp(IdempotencyRequestTooLarge(), IDEMPOTENCY_FAILURES);
      let body: Awaited<ReturnType<typeof readCapped>>;
      try {
        body = await readCapped(req.clone().body, maxBodyBytes);
      } catch (error) {
        return orThrowHttp(
          cancelled() ? RequestCancelled() : IdempotencyRequestUnreadable({ cause: error }),
          IDEMPOTENCY_FAILURES,
        );
      }
      if (cancelled()) return orThrowHttp(RequestCancelled(), IDEMPOTENCY_FAILURES);
      if (body === undefined) return orThrowHttp(IdempotencyRequestTooLarge(), IDEMPOTENCY_FAILURES);

      // Secure ownership must be established before hashing, cache acquisition or application effects.
      const owner = idempotencyOwnerId.create();
      if (isFailure(owner)) return orThrowHttp(owner, IDEMPOTENCY_FAILURES);
      const key = await sha256(`${principal.length}:${principal}${supplied}`);
      if (cancelled()) return orThrowHttp(RequestCancelled(), IDEMPOTENCY_FAILURES);
      if (isFailure(key)) return orThrowHttp(key, IDEMPOTENCY_FAILURES);
      const fingerprint = await fingerprintOf(req, url, body);
      if (cancelled()) return orThrowHttp(RequestCancelled(), IDEMPOTENCY_FAILURES);
      if (isFailure(fingerprint)) return orThrowHttp(fingerprint, IDEMPOTENCY_FAILURES);

      let outcome: Awaited<ReturnType<ResponseCache['begin']>>;
      try {
        outcome = await cache.begin(key, fingerprint, owner);
      } catch (error) {
        outcome = IdempotencyClaimUnconfirmed({ cause: error });
      }
      if (isFailure(outcome)) return orThrowHttp(outcome, IDEMPOTENCY_FAILURES);
      if (outcome === 'conflict') return orThrowHttp(IdempotencyKeyReused(), IDEMPOTENCY_FAILURES);
      if (outcome === 'in-progress') {
        return orThrowHttp(IdempotencyInProgress(), IDEMPOTENCY_FAILURES, { headers: { 'retry-after': '1' } });
      }
      if (outcome !== 'started') {
        try {
          return replayResponse(outcome.replay);
        } catch (error) {
          return orThrowHttp(IdempotencyReplayInvalid({ cause: error }), IDEMPOTENCY_FAILURES);
        }
      }

      // After dispatch, even an exception or 5xx can follow a committed business effect.
      const response = await next(req);
      let stored: StoredResponse | undefined;
      try {
        const streaming = response.headers.get('content-type')?.startsWith('text/event-stream') === true;
        if (!streaming) {
          const bytes = await readCapped(response.clone().body, maxBodyBytes);
          if (bytes !== undefined) {
            const headers: Record<string, string> = {};
            for (const [name, value] of response.headers) if (allowed.has(name)) headers[name] = value;
            stored = { status: response.status, headers, body: toBase64(bytes) };
          }
        }
      } catch (error) {
        discardResponse(response);
        return orThrowHttp(IdempotencyResponseUnavailable({ cause: error }), IDEMPOTENCY_FAILURES);
      }
      if (stored === undefined) {
        discardResponse(response);
        return orThrowHttp(IdempotencyResponseUnavailable(), IDEMPOTENCY_FAILURES);
      }
      let finished: Awaited<ReturnType<ResponseCache['finish']>>;
      try {
        finished = await cache.finish(key, owner, stored, ttl);
      } catch (error) {
        finished = IdempotencyWriteUnconfirmed({ cause: error });
      }
      if (isFailure(finished)) {
        discardResponse(response);
        return orThrowHttp(finished, IDEMPOTENCY_FAILURES);
      }
      return response;
    });
  };
}
