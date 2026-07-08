/**
 * The request engine — builds one fetch handler from a list of bundles.
 *
 * Hono does the routing internally; no Hono type appears in the public
 * API, so the engine stays a swappable implementation detail. The route
 * table order is bundle order then binding order — declaration order,
 * deterministically, per DOT principle 3.
 */
import type { RouteBundle } from './bundle.js';
/** A built engine: the composed fetch handler plus its route inventory. */
export type Engine = {
    readonly fetch: (req: Request) => Promise<Response>;
    /** Contract ids + mount ids, in registration order. */
    readonly routeIds: readonly string[];
};
/**
 * Compose bundles into a single fetch handler. Throws
 * `ARKI_HTTP_E002`/`E006` on route collisions and malformed mounts —
 * callers (the `http()` plugin's `boot`) let these bubble as boot failures.
 */
export declare function buildEngine(bundles: readonly RouteBundle[]): Engine;
/**
 * App-wide middleware: a fetch-shaped wrapper. The first middleware in a
 * list runs outermost. Use for cross-cutting concerns that must see or
 * touch the raw request/response — CORS, request logging, compression.
 * For per-request *values* (auth principals, tenant handles), use
 * derivers — they are typed into handler contexts; middleware is not.
 */
export type HttpMiddleware = (req: Request, next: (req: Request) => Promise<Response>) => Response | Promise<Response>;
/**
 * Wrap a fetch handler in middleware (first = outermost). A middleware
 * that throws resolves to the coded error envelope — `HttpError` keeps
 * its status, anything else is a 500.
 */
export declare function composeMiddleware(fetch: (req: Request) => Promise<Response>, middleware: readonly HttpMiddleware[]): (req: Request) => Promise<Response>;
//# sourceMappingURL=engine.d.ts.map