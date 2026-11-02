/**
 * A typed fetch client built from the same route contracts the server binds.
 *
 * ```ts
 * import { createClient } from '@arki/http/client';
 * import { getOrder, listOrders } from './contracts';
 *
 * const orders = createClient({ getOrder, listOrders }, { baseUrl: 'https://api.example.com' });
 * const order = await orders.getOrder({ params: { id: 'o42' } });
 * ```
 *
 * Inputs are typed from the contract and encoded the way the server decodes
 * them: each param, header and query field and the body run through their
 * schema in the encode direction (a `codec()` turns a `Date` into its ISO
 * string; a bare schema is its own encoder), and path params are
 * URL-escaped. A missing `optional(...)` field is left out.
 *
 * The result follows the contract: a status listed in `responses` decodes
 * with that schema, a success decodes with `output`, a route without `output`
 * resolves `undefined` (it answers 204), and a `raw()` route resolves the
 * `Response`. A failed call whose code is one of the contract's `failures`
 * resolves to that failure, revived and its data checked with the
 * definition's schema. Client-owned validation, network, cancellation and protocol
 * outcomes resolve to their canonical failures too.
 *
 * Uses only `fetch` — no Node APIs — so it runs in browsers, React Native,
 * Deno, Bun and Node. This is why it lives at its own subpath: the root entry
 * pulls in the server engine.
 */
import type { PolicyExecution, ResilienceFailure } from '@arki/resilience';
import type { PathParams, ResponseSchemas, RouteContract, RouteDef, RouteFailure, RouteInput } from './contract.js';
import type { HttpClientFailure } from './failures.js';
import type { RawOutput } from './raw.js';
import type { Wire, WireValue } from './wire.js';
export { HTTP_CLIENT_FAILURES, NetworkFailure, RequestCancelled, RequestTimeout } from './failures.js';
export type { HttpClientFailure } from './failures.js';
/** Any JSON route contract — what {@link createClient} accepts. */
type AnyRoute = RouteContract<string, RouteDef<string>>;
/** Nothing to pass: the identity for the input intersections below. */
type NoInput = Record<never, never>;
type ParamsInput<TPath extends string, TParams> = [PathParams<TPath>] extends [never] ? NoInput : NoInput extends TParams ? {
    readonly params?: TParams;
} : {
    readonly params: TParams;
};
/** An input the caller may leave out when every field of it is optional. */
type OptionalWhenEmpty<TName extends string, TValue> = [TValue] extends [undefined] ? NoInput : NoInput extends TValue ? Partial<Readonly<Record<TName, TValue>>> : Readonly<Record<TName, TValue>>;
type BodyInput<TBody> = [TBody] extends [undefined] ? NoInput : {
    readonly body: TBody;
};
/**
 * What one client call takes: `params` when the path has parameters, and
 * `query`, `headers` and `body` when the contract declares them. Each is the
 * value form — the same values the server handler receives; a field marked
 * `optional(...)` may be left out.
 */
export type ClientInput<TRoute> = TRoute extends {
    readonly path: infer TPath extends string;
} ? Flatten<ParamsInput<TPath, RouteInput<TPath, TRoute>['params']> & OptionalWhenEmpty<'query', RouteInput<TPath, TRoute>['query']> & OptionalWhenEmpty<'headers', RouteInput<TPath, TRoute>['headers']> & BodyInput<RouteInput<TPath, TRoute>['body']>> : never;
/** Merge an intersection into one object type, so editors show it plainly. */
type Flatten<T> = {
    [K in keyof T]: T[K];
};
type SuccessOf<TRoute> = TRoute extends {
    readonly output: infer TOutput;
} ? TOutput extends Wire ? WireValue<TOutput> : never : undefined;
type StatusBodies<TRoute> = TRoute extends {
    readonly responses: infer TResponses extends ResponseSchemas;
} ? {
    [S in keyof TResponses & number]: WireValue<TResponses[S]>;
}[keyof TResponses & number] : never;
/**
 * What one client call resolves to: the output's value form
 * (`undefined` when the contract has no output, `Response` for `raw()`),
 * the body of a status listed in `responses`, or one of the failures the
 * contract lists.
 */
export type ClientOutput<TRoute> = TRoute extends {
    readonly output: RawOutput;
} ? Response | RouteFailure<TRoute> | HttpClientFailure : SuccessOf<TRoute> | StatusBodies<TRoute> | RouteFailure<TRoute> | HttpClientFailure;
/** Per-call options: an abort signal and extra request headers. */
type CallInit = {
    readonly signal?: AbortSignal;
    readonly headers?: Readonly<Record<string, string>>;
};
/** One typed call. The input argument may be left out when nothing is required. */
export type ClientCall<TRoute> = NoInput extends ClientInput<TRoute> ? (input?: ClientInput<TRoute>, init?: CallInit) => Promise<ClientOutput<TRoute>> : (input: ClientInput<TRoute>, init?: CallInit) => Promise<ClientOutput<TRoute>>;
/**
 * What the client needs from a retry policy: an `@arki/resilience` policy fits. A policy with a
 * fallback does not, because its result could be the fallback instead of a response.
 */
export type ClientPolicy = PolicyExecution<never, ResilienceFailure>;
/** One attempt's outcome, as `retryOn` sees it: the response, or the error `fetch` threw. */
export type RetryOutcome = {
    readonly method: string;
    /** True for GET, HEAD, OPTIONS, PUT and DELETE, and for any request with an `idempotency-key` header. */
    readonly repeatable: boolean;
} & ({
    readonly response: Response;
    readonly error?: never;
} | {
    readonly error: unknown;
    readonly response?: never;
});
/** Options for {@link createClient}. */
export type ClientOptions = {
    /** Origin plus any path prefix, e.g. `https://api.example.com/v1`. A relative prefix (`/api`) works where fetch allows it. */
    readonly baseUrl: string;
    /**
     * The fetch to use. Defaults to the global `fetch`. Wrap it to add auth headers. On a server that
     * calls URLs it does not fully control, pass `publicFetch()` from `@arki/http/public-fetch`.
     */
    readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
    /**
     * Gives up once the response has not arrived within this many milliseconds, retries included,
     * and returns `RequestTimeout` (408). Reading the body is not timed.
     */
    readonly timeoutMs?: number;
    /**
     * Runs each attempt, so it can retry and back off. Only an outcome `retryOn` accepts is retried;
     * any other answer or error leaves the policy at once, whatever the policy itself would retry.
     */
    readonly policy?: ClientPolicy;
    /** Which outcomes `policy` retries. Default {@link retryTransient}. */
    readonly retryOn?: (outcome: RetryOutcome) => boolean;
};
/**
 * The default `retryOn`: a network failure (`fetch` throws a `TypeError`) or a 408, 429, 502, 503
 * or 504, and only on a request that is safe to send twice. A POST without an idempotency key is
 * never retried: the first try may have done the work before the answer was lost.
 */
export declare function retryTransient(outcome: RetryOutcome): boolean;
/** Build one typed call from a single contract. */
export declare function createClient<TRoute extends AnyRoute>(contract: TRoute, options: ClientOptions): ClientCall<TRoute>;
/** Build one typed call per contract, under the same keys. */
export declare function createClient<TRoutes extends Readonly<Record<string, AnyRoute>>>(contracts: TRoutes, options: ClientOptions): {
    readonly [K in keyof TRoutes]: ClientCall<TRoutes[K]>;
};
//# sourceMappingURL=client.d.ts.map