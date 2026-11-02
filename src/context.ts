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

import { AsyncLocalStorage } from 'node:async_hooks';

import type { BaseRequestCtx } from './derive.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';

const storage = new AsyncLocalStorage<BaseRequestCtx>();

/**
 * Whether any engine in this process runs requests inside the store.
 * `no-engine`: none built yet (a worker, a test calling handlers directly);
 * `disabled`: engines exist, none opted in; `enabled`: at least one did.
 */
let state: 'no-engine' | 'disabled' | 'enabled' = 'no-engine';

/** Engine seam: an engine was built; `enabled` says whether it runs requests inside the store. */
export function registerEngineContext(enabled: boolean): void {
  if (enabled) state = 'enabled';
  else if (state === 'no-engine') state = 'disabled';
}

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
export function requestContext(): BaseRequestCtx | undefined {
  if (state === 'disabled') {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.requestContextDisabled,
      message: '[http] requestContext() was called, but no engine in this process was built with { requestContext: true }.',
      remediation:
        'Pass { requestContext: true } to buildEngine or buildHonoEngine (requestContext: true on http() for a Dot app), or read the explicit ctx parameter instead.',
      docsUrl: 'https://arki.dev/http/errors/arki-http-e014',
    });
  }
  return storage.getStore();
}

/**
 * Engine seam: run `fn` with `ctx` as the ambient request context. Called
 * by an engine built with `{ requestContext: true }` around every request —
 * not part of the public surface.
 */
export function runWithRequestContext<T>(ctx: BaseRequestCtx, fn: () => T): T {
  return storage.run(ctx, fn);
}
