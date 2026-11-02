/**
 * Ambient request context — the last resort.
 *
 * Explicit `ctx` threading fails in one honest case: code deep in a call
 * stack whose signatures you don't control (log enrichment inside a
 * shared library). For that, this entry exposes the current request's
 * {@link BaseRequestCtx} via `AsyncLocalStorage`.
 *
 * Ambient context is a smell — prefer the explicit `ctx` parameter and
 * steps everywhere a signature is yours to change. Note that OTel
 * trace context already propagates this way, so span/log correlation
 * needs none of this.
 *
 * This module is deliberately NOT re-exported from the package root.
 * Import it as `@arki/http/context`.
 */
import type { BaseRequestCtx } from './derive.js';
/** Engine seam: an engine was built; `enabled` says whether it runs requests inside the store. */
export declare function registerEngineContext(enabled: boolean): void;
/**
 * The context of the request currently being handled, or `undefined`
 * outside a request (startup, background jobs, tests that call handlers
 * directly).
 *
 * Needs an engine built with `{ requestContext: true }`: entering the store
 * costs every request, so it is off unless an app asks for it. Calling this
 * when engines exist but none opted in throws `ARKI_HTTP_E014`, so a missing
 * option is a loud error, not a silent `undefined`.
 */
export declare function requestContext(): BaseRequestCtx | undefined;
/**
 * Engine seam: run `fn` with `ctx` as the ambient request context. Called
 * by an engine built with `{ requestContext: true }` around every request —
 * not part of the public surface.
 */
export declare function runWithRequestContext<T>(ctx: BaseRequestCtx, fn: () => T): T;
//# sourceMappingURL=context.d.ts.map