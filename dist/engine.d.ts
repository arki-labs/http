/**
 * The Hono engine — builds one fetch handler from a list of bundles, with
 * Hono doing the routing — and the per-route pipeline every engine shares
 * (`executeBinding`: request context, input decoding, the handler, the
 * response, the error envelope).
 *
 * `buildEngine` (compiled.ts) is the default engine: its own router for the
 * routes it can match, this engine for the rest. No Hono type appears in
 * the public API, so routing stays a swappable implementation detail. The
 * route table order is bundle order then binding order — declaration
 * order, deterministically, per DOT principle 3.
 */
import type { RouteBinding, RouteBundle } from './bundle.js';
import type { ContractLike } from './contract.js';
import type { BaseRequestCtx } from './derive.js';
/** What `Bun.serve` passes a `routes` handler: the request with its matched path parameters. */
export type BunRequestLike = Request & {
    readonly params: Readonly<Record<string, string>>;
};
/** A `Bun.serve` `routes` table: path → method → handler. */
export type BunRoutes = Readonly<Record<string, Readonly<Record<string, (req: BunRequestLike) => Response | Promise<Response>>>>>;
/** What `buildEngine` and `buildHonoEngine` take besides the bundles. */
export type EngineOptions = {
    /**
     * Run every request inside the ambient store, so `requestContext()`
     * (`@arki/http/context`) answers from anywhere in the call stack. Off by
     * default: entering the store costs every request, and the explicit `ctx`
     * parameter covers almost every need.
     */
    readonly requestContext?: boolean;
};
/** How an engine runs one request's work: inside the ambient store, or as is. */
export type RequestScope = <T>(ctx: BaseRequestCtx, fn: () => T) => T;
/** The scope the options ask for; records with the context module whether this engine opted in. */
export declare function requestScopeOf(options: EngineOptions | undefined): RequestScope;
/** A built engine: the composed fetch handler plus its route inventory. */
export type Engine = {
    readonly fetch: (req: Request) => Promise<Response>;
    /**
     * The routes Bun can match natively, when the engine has any. `listen`
     * hands them to `Bun.serve({ routes })`; a request they match never
     * reaches `fetch`. Both answer the same.
     */
    readonly bunRoutes?: BunRoutes;
    /** Contract ids + mount ids, in registration order. */
    readonly routeIds: readonly string[];
};
/** The Hono app behind {@link buildHonoEngine}: its fetch without the request span, and the route ids. */
export declare function buildHonoApp(bundles: readonly RouteBundle[], options?: EngineOptions): {
    readonly fetch: (req: Request) => Response | Promise<Response>;
    readonly routeIds: readonly string[];
};
/**
 * Compose bundles into a single fetch handler. Throws
 * `ARKI_HTTP_E002`/`E006` on route collisions and malformed mounts —
 * callers (the `http()` plugin's `boot`) let these bubble as boot failures.
 */
export declare function buildHonoEngine(bundles: readonly RouteBundle[], options?: EngineOptions): Engine;
/**
 * Claim a route's method and path(s) for its contract id; a second claim
 * on the same key is a duplicate route. An optional placeholder ("/a/:x?")
 * serves two paths and claims both.
 */
export declare function claimRoute(claimed: Map<string, string>, contract: ContractLike): void;
/**
 * Run one bound route. A route with no stages and no body has nothing to
 * await before its handler, so when its schemas answer synchronously it runs
 * synchronously and returns the Response itself when the handler does — no
 * promise, no extra microtask. Anything that needs an await goes through
 * `executeBindingAsync`. Both paths give the same responses and the same
 * error envelopes. Every engine calls this once per matched route; only
 * the match (and so `params`) and the `scope` are the engine's own.
 */
export declare function executeBinding(bundle: RouteBundle, binding: RouteBinding, req: Request, params: Readonly<Record<string, string>>, scope: RequestScope): Response | Promise<Response>;
/**
 * App-wide middleware: a fetch-shaped wrapper. The first middleware in a
 * list runs outermost. Use for cross-cutting concerns that must see or
 * touch the raw request/response — CORS, request logging, compression.
 * For per-request *values* (auth principals, tenant handles), use
 * bundle steps — they are typed into handler contexts; middleware is not.
 */
export type HttpMiddleware = (req: Request, next: (req: Request) => Promise<Response>) => Response | Promise<Response>;
/**
 * Wrap a fetch handler in middleware (first = outermost). A middleware
 * that throws resolves to the coded error envelope — `HttpError` keeps
 * its status, anything else is a 500.
 */
export declare function composeMiddleware(fetch: (req: Request) => Promise<Response>, middleware: readonly HttpMiddleware[]): (req: Request) => Promise<Response>;
/**
 * Wrap a whole engine: its `fetch` and, when it has them, every Bun route
 * handler, so a request Bun matches natively still runs the same layers.
 * A layer that forwards a different `Request` loses the native match; the
 * engine then routes that request itself.
 */
export declare function composeMiddleware(engine: Engine, middleware: readonly HttpMiddleware[]): Engine;
//# sourceMappingURL=engine.d.ts.map