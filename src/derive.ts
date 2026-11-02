import type { Failure } from '@arki/failure';

import type { RequestId } from './ids.js';

/**
 * Request-scope types: the base context, and the bundle's stored stages.
 *
 * A bundle runs its steps and arounds (see `middleware.ts`) before the
 * handler, in declaration order. A step adds the keys of the object it
 * returns, so later steps and handlers see them typed; a returned canonical
 * failure short-circuits into the wire envelope:
 *
 * ```ts
 * const SignIn = defineFailure('auth.sign_in', { status: 401 });
 * const withPrincipal = step(async ({ req }: BaseRequestCtx) => {
 *   const p = await auth.verify(req.headers.get('authorization'));
 *   return p === null ? SignIn() : { principal: p };
 * });
 * ```
 *
 * Because bundles are assembled inside a plugin's `boot`, steps close over
 * injected singletons — request scope is function application over the
 * compile-time-wired service graph, not per-request container resolution.
 */

/**
 * The context every handler and step receives. Steps extend it with
 * their own typed keys.
 */
export type BaseRequestCtx = {
  readonly req: Request;
  readonly url: URL;
  /** Inbound `x-request-id` header, else a fresh UUID. */
  readonly requestId: RequestId;
  /** Aborts when the client disconnects. */
  readonly signal: AbortSignal;
};

/** Transport metadata for an inferred returned failure; execution remains server-bound. */
export type FailureHeaders<Value> = {
  readonly failureHeaders?: (
    this: void,
    failure: Extract<Awaited<Value>, Failure>,
  ) => Readonly<Record<string, string>> | undefined;
};

/**
 * Generics-erased {@link FailureHeaders} for bundle storage. Typed stages are
 * assignable via parameter contravariance from the bottom type; the engine
 * crosses the erasure boundary at the call site (`ctx as never`), mirroring
 * the DOT kernel's hook-storage pattern.
 */
export type ErasedFailureHeaders = {
  failureHeaders?(this: void, failure: Failure): ReturnType<NonNullable<FailureHeaders<Failure>['failureHeaders']>>;
};

/**
 * A step in the bundle's stage list: a plain function whose returned object is
 * spread into the context (see `step` in `middleware.ts`). Stored erased.
 */
export type ErasedStep = ErasedFailureHeaders & {
  readonly step: (ctx: never) => object | PromiseLike<object>;
};

/**
 * An around in the bundle's stage list: wraps every stage declared after it and
 * the handler (see `around` in `middleware.ts`). Stored erased.
 */
export type ErasedAround = {
  readonly around: (ctx: never, next: () => Promise<Response>) => Promise<Response>;
};

/** Everything a bundle runs before the handler, in declaration order. */
export type ErasedStage = ErasedStep | ErasedAround;
