/**
 * Ambient request context — the last resort.
 *
 * Explicit `ctx` threading fails in one honest case: code deep in a call
 * stack whose signatures you don't control (log enrichment inside a
 * shared library). For that, this entry exposes the current request's
 * {@link BaseRequestCtx} via `AsyncLocalStorage`.
 *
 * Ambient context is a smell — prefer the explicit `ctx` parameter and
 * derivers everywhere a signature is yours to change. Note that OTel
 * trace context already propagates this way, so span/log correlation
 * needs none of this.
 *
 * This module is deliberately NOT re-exported from the package root.
 * Import it as `@arki/http/context`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { BaseRequestCtx } from './derive.js';

const storage = new AsyncLocalStorage<BaseRequestCtx>();

/**
 * The context of the request currently being handled, or `undefined`
 * outside a request (startup, background jobs, tests that call handlers
 * directly).
 */
export function requestContext(): BaseRequestCtx | undefined {
  return storage.getStore();
}

/**
 * Engine seam: run `fn` with `ctx` as the ambient request context. Called
 * by the engine around every request — not part of the public surface.
 */
export function runWithRequestContext<T>(ctx: BaseRequestCtx, fn: () => T): T {
  return storage.run(ctx, fn);
}
