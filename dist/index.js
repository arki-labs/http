/**
 * `@arki/http` — typed HTTP for ARKI.
 *
 * Route contracts as data ({@link route}), Standard-Schema-validated handlers bound in
 * a typed bundle builder ({@link routes}), request-scope steps and arounds
 * ({@link step}, {@link around}), SSE streaming, and deterministic OpenAPI
 * generation ({@link toOpenApi}).
 *
 * The framework-agnostic core lives here — {@link buildEngine} +
 * {@link listen} run a server without any framework. The DOT adapter (the
 * `http()` driver) lives at `@arki/http/dot`; the ambient request context —
 * a deliberate last resort — at `@arki/http/context`.
 */
export { route } from './contract.js';
export { codec, optional } from './wire.js';
export { raw } from './raw.js';
export { reply, routes, rpcMount } from './bundle.js';
export { around, step } from './middleware.js';
export { requestId } from './ids.js';
export { describeInternalError, errorResponse, HTTP_ERROR_CODES, HttpConfigError, HttpError, orThrowHttp, toErrorResponse, } from './error.js';
export { contractMeta, toOpenApi } from './openapi.js';
export { buildEngine } from './compiled.js';
export { buildHonoEngine, composeMiddleware } from './engine.js';
export { listen } from './listen.js';
export { IDEMPOTENCY_FAILURES, HTTP_CLIENT_FAILURES, HTTP_SERVER_FAILURES, NetworkFailure, RequestCancelled, RequestTimeout, IdempotencyKeyRequired, IdempotencyKeyReused, IdempotencyInProgress, IdempotencyClaimUnconfirmed, IdempotencyWriteUnconfirmed, IdempotencyReleaseUnconfirmed, IdempotencyOwnershipLost, IdempotencyReplayInvalid, IdempotencyResponseUnavailable, IdempotencyRequestTooLarge, IdempotencyRequestUnreadable, IdempotencyHashUnavailable, RESPONSE_CACHE_BEGIN_FAILURES, RESPONSE_CACHE_FINISH_FAILURES, RESPONSE_CACHE_ABANDON_FAILURES, } from './failures.js';
//# sourceMappingURL=index.js.map