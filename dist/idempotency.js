import { isFailure, UnexpectedDefect } from '@arki/failure';
import { idempotencyOwnerId } from './ids.js';
import { storedResponseSchema } from './stored-response.js';
import { observeHttp } from './telemetry.js';
import { fromBase64, readCapped, toBase64, toHex } from './bytes.js';
import { HTTP_ERROR_CODES, HttpConfigError, orThrowHttp } from './error.js';
import { IDEMPOTENCY_FAILURES, IdempotencyInProgress, IdempotencyKeyRequired, IdempotencyKeyReused, IdempotencyClaimUnconfirmed, IdempotencyWriteUnconfirmed, IdempotencyReplayInvalid, IdempotencyResponseUnavailable, IdempotencyRequestTooLarge, IdempotencyRequestUnreadable, IdempotencyHashUnavailable, RequestCancelled, } from './failures.js';
export { IDEMPOTENCY_FAILURES, IdempotencyKeyRequired, IdempotencyKeyReused, IdempotencyInProgress, IdempotencyClaimUnconfirmed, IdempotencyWriteUnconfirmed, IdempotencyReleaseUnconfirmed, IdempotencyOwnershipLost, IdempotencyReplayInvalid, IdempotencyResponseUnavailable, IdempotencyRequestTooLarge, IdempotencyRequestUnreadable, IdempotencyHashUnavailable, RESPONSE_CACHE_BEGIN_FAILURES, RESPONSE_CACHE_FINISH_FAILURES, RESPONSE_CACHE_ABANDON_FAILURES, } from './failures.js';
export { idempotencyOwnerId } from './ids.js';
/** Checks a {@link StoredResponse} read back from a cache: `parse(storedResponse, value)` from `@arki/schema`. */
export const storedResponse = storedResponseSchema;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_REPLAY_HEADERS = ['content-type', 'location', 'etag'];
const MAX_KEY_LENGTH = 255;
const textEncoder = new TextEncoder();
/** Web Crypto is a foreign boundary: preserve its receiver and validate its digest protocol. */
const sha256 = async (data) => {
    try {
        const crypto = Reflect.get(globalThis, 'crypto');
        if (typeof crypto !== 'object' || crypto === null)
            return IdempotencyHashUnavailable();
        const subtle = Reflect.get(crypto, 'subtle');
        if (typeof subtle !== 'object' || subtle === null)
            return IdempotencyHashUnavailable();
        const digest = Reflect.get(subtle, 'digest');
        if (typeof digest !== 'function')
            return IdempotencyHashUnavailable();
        const result = await Reflect.apply(digest, subtle, [
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
    }
    catch (error) {
        return UnexpectedDefect({ cause: error });
    }
};
/** `'POST /orders/:id'` to a method and an anchored path pattern. */
const compileRoute = (route) => {
    const path = route.path
        .split('/')
        .map(segment => {
        if (segment.startsWith(':'))
            return segment.endsWith('?') ? '(?:/[^/]+)?' : '/[^/]+';
        return segment === '' ? '' : `/${segment.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw `\$&`)}`;
    })
        .join('');
    return { method: route.method, path: new RegExp(`^${path === '' ? '/' : path}/?$`), failures: route.failures ?? [] };
};
/** Method + path + sorted query + body hash, hashed. Two requests share a fingerprint only when they ask for the same thing. */
const fingerprintOf = async (req, url, body) => {
    const query = [...url.searchParams].toSorted(([a, av], [b, bv]) => a === b ? av.localeCompare(bv) : a.localeCompare(b));
    const bodyHash = await sha256(body);
    if (req.signal.aborted)
        return RequestCancelled();
    if (isFailure(bodyHash))
        return bodyHash;
    return sha256(`${req.method}\n${url.pathname}\n${JSON.stringify(query)}\n${bodyHash}`);
};
const replayResponse = (stored) => {
    const headers = new Headers(stored.headers);
    headers.set('idempotent-replayed', 'true');
    const bodyless = stored.status === 204 || stored.status === 205 || stored.status === 304;
    return new Response(bodyless ? null : fromBase64(stored.body), { status: stored.status, headers });
};
/** Release unread response resources without granting permission to repeat application work. */
function discardResponse(response) {
    try {
        void response.body?.cancel().catch(() => null);
    }
    catch {
        // A foreign/locked stream may refuse cancellation; the reservation remains held.
    }
}
export function idempotent(options) {
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
        if (pattern === undefined)
            return next(req);
        return observeHttp('http.idempotency', async () => {
            // Read afresh across awaits: cancellation can change while foreign work runs.
            const cancelled = () => req.signal.aborted;
            if (cancelled())
                return orThrowHttp(RequestCancelled(), IDEMPOTENCY_FAILURES);
            // Callbacks may come from JavaScript; validate their result before it can scope a key.
            let principal;
            try {
                principal = await scope(req);
            }
            catch (error) {
                return orThrowHttp(cancelled() ? RequestCancelled() : UnexpectedDefect({ cause: error }), IDEMPOTENCY_FAILURES);
            }
            if (cancelled())
                return orThrowHttp(RequestCancelled(), IDEMPOTENCY_FAILURES);
            if (isFailure(principal))
                return orThrowHttp(principal, pattern.failures);
            if (principal === undefined)
                return next(req);
            if (typeof principal !== 'string') {
                return orThrowHttp(UnexpectedDefect({ cause: new TypeError('Idempotency scope returned an invalid result.') }), IDEMPOTENCY_FAILURES);
            }
            const supplied = req.headers.get(headerName)?.trim();
            if (supplied === undefined || supplied === '' || supplied.length > MAX_KEY_LENGTH) {
                orThrowHttp(IdempotencyKeyRequired(), IDEMPOTENCY_FAILURES);
            }
            const declared = Number(req.headers.get('content-length') ?? 0);
            if (declared > maxBodyBytes)
                return orThrowHttp(IdempotencyRequestTooLarge(), IDEMPOTENCY_FAILURES);
            let body;
            try {
                body = await readCapped(req.clone().body, maxBodyBytes);
            }
            catch (error) {
                return orThrowHttp(cancelled() ? RequestCancelled() : IdempotencyRequestUnreadable({ cause: error }), IDEMPOTENCY_FAILURES);
            }
            if (cancelled())
                return orThrowHttp(RequestCancelled(), IDEMPOTENCY_FAILURES);
            if (body === undefined)
                return orThrowHttp(IdempotencyRequestTooLarge(), IDEMPOTENCY_FAILURES);
            // Secure ownership must be established before hashing, cache acquisition or application effects.
            const owner = idempotencyOwnerId.create();
            if (isFailure(owner))
                return orThrowHttp(owner, IDEMPOTENCY_FAILURES);
            const key = await sha256(`${principal.length}:${principal}${supplied}`);
            if (cancelled())
                return orThrowHttp(RequestCancelled(), IDEMPOTENCY_FAILURES);
            if (isFailure(key))
                return orThrowHttp(key, IDEMPOTENCY_FAILURES);
            const fingerprint = await fingerprintOf(req, url, body);
            if (cancelled())
                return orThrowHttp(RequestCancelled(), IDEMPOTENCY_FAILURES);
            if (isFailure(fingerprint))
                return orThrowHttp(fingerprint, IDEMPOTENCY_FAILURES);
            let outcome;
            try {
                outcome = await cache.begin(key, fingerprint, owner);
            }
            catch (error) {
                outcome = IdempotencyClaimUnconfirmed({ cause: error });
            }
            if (isFailure(outcome))
                return orThrowHttp(outcome, IDEMPOTENCY_FAILURES);
            if (outcome === 'conflict')
                return orThrowHttp(IdempotencyKeyReused(), IDEMPOTENCY_FAILURES);
            if (outcome === 'in-progress') {
                return orThrowHttp(IdempotencyInProgress(), IDEMPOTENCY_FAILURES, { headers: { 'retry-after': '1' } });
            }
            if (outcome !== 'started') {
                try {
                    return replayResponse(outcome.replay);
                }
                catch (error) {
                    return orThrowHttp(IdempotencyReplayInvalid({ cause: error }), IDEMPOTENCY_FAILURES);
                }
            }
            // After dispatch, even an exception or 5xx can follow a committed business effect.
            const response = await next(req);
            let stored;
            try {
                const streaming = response.headers.get('content-type')?.startsWith('text/event-stream') === true;
                if (!streaming) {
                    const bytes = await readCapped(response.clone().body, maxBodyBytes);
                    if (bytes !== undefined) {
                        const headers = {};
                        for (const [name, value] of response.headers)
                            if (allowed.has(name))
                                headers[name] = value;
                        stored = { status: response.status, headers, body: toBase64(bytes) };
                    }
                }
            }
            catch (error) {
                discardResponse(response);
                return orThrowHttp(IdempotencyResponseUnavailable({ cause: error }), IDEMPOTENCY_FAILURES);
            }
            if (stored === undefined) {
                discardResponse(response);
                return orThrowHttp(IdempotencyResponseUnavailable(), IDEMPOTENCY_FAILURES);
            }
            let finished;
            try {
                finished = await cache.finish(key, owner, stored, ttl);
            }
            catch (error) {
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
//# sourceMappingURL=idempotency.js.map