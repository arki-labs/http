/**
 * `step` and `around` for route bundles: plain functions, attached with
 * `routes().use(...)`. Nothing is shared at runtime; the types come from the
 * function itself.
 */
import type { FailureHeaders } from './derive.js';

/** What {@link step} makes: reads `In`, returns `R` (an object to add, or a failure). */
export type HttpStep<In, R extends object | PromiseLike<object>> = FailureHeaders<R> & {
  readonly step: (context: In) => R;
};

/** What {@link around} makes: wraps the rest of the bundle and the handler, adds nothing. */
export type HttpAround<In> = {
  readonly around: <T>(context: In, next: () => Promise<T>) => Promise<T>;
};

/**
 * Run a step before the handler: `routes().use(step(authed))`.
 *
 * A step is a plain function. Its parameter is the least context it reads
 * (the request context, plus every key added before it); it returns an object
 * to add to the context, or a failure to refuse the call:
 *
 *   const authed = (ctx: { principal: Principal | null }) =>
 *     ctx.principal === null ? SignInRequired() : { principal: ctx.principal };
 *
 * A refusal answers with the coded failure envelope, so every route bound
 * after the step must declare the step's failures. The return must
 * be an object (or a failure), sync or async. The same function attaches to
 * the other transports with their own `step`.
 *
 * `failureHeaders` adds response headers to a refusal, typed by the step's
 * own failures (a `www-authenticate` challenge on a 401, say).
 */
export function step<In, R extends object | PromiseLike<object>>(
  fn: (context: In) => R,
  options: FailureHeaders<R> = {},
): HttpStep<In, R> {
  return { step: fn, ...options };
}

/**
 * Wrap a route: `routes().use(around(inTransaction))`.
 *
 * An around is a plain function that runs `next` inside whatever it sets up
 * (a transaction, a retry, a span, a timeout) and returns what `next` returns.
 * It wraps every step declared after it and the handler, and sees a refusal
 * (as the response) or a handler error (as a throw). For an SSE route it wraps
 * opening the stream, not the events after it.
 *
 *   const inTransaction = <T>(ctx: { db: Db }, next: () => Promise<T>) => ctx.db.transaction(() => next());
 */
export function around<In>(fn: <T>(context: In, next: () => Promise<T>) => Promise<T>): HttpAround<In> {
  return { around: fn };
}
