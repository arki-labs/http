/**
 * `@arki/http` — typed HTTP for ARKI.
 *
 * Route contracts as data ({@link route}), zod-validated handlers bound in
 * a typed bundle builder ({@link routes}), request-scope derivers
 * ({@link derive}), SSE streaming, and deterministic OpenAPI generation
 * ({@link toOpenApi}).
 *
 * The framework-agnostic core lives here — {@link buildEngine} +
 * {@link listen} run a server without any framework. The DOT adapter (the
 * `http()` pip) lives at `@arki/http/dot`; the ambient request context —
 * a deliberate last resort — at `@arki/http/context`.
 */

export { route } from './contract.js';
export type {
  ContractLike,
  HttpMethod,
  ParamsOf,
  PathParams,
  RouteContract,
  SchemaLike,
  SseContract,
} from './contract.js';

export { routes } from './bundle.js';
export type {
  HandlerResult,
  MountBinding,
  MountMeta,
  MountTransport,
  RouteBinding,
  RouteBundle,
  RouteBundleBuilder,
  RouteHandler,
  RouteInput,
  SseHandler,
} from './bundle.js';

export { BASE_CTX_KEYS, derive } from './derive.js';
export type { BaseRequestCtx, Deriver, ErasedDeriver } from './derive.js';

export { describeInternalError, errorResponse, HTTP_ERROR_CODES, HttpConfigError, HttpError, toErrorResponse } from './error.js';
export type { HttpErrorEnvelope } from './error.js';

export { contractMeta, toOpenApi } from './openapi.js';
export type { OpenApiInfo, RouteMeta } from './openapi.js';

export { buildEngine, composeMiddleware } from './engine.js';
export type { Engine, HttpMiddleware } from './engine.js';

export { listen } from './listen.js';
export type { ListenHandle, ListenOptions } from './listen.js';
