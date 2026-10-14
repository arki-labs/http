/**
 * DOT adapter for `@arki/http` — the `http()` driving adapter.
 *
 * `http()` is a driver: `.serve(http(...))` binds it to the features the
 * app mounted, and it serves every feature's `routes` slice (declared with
 * `endpoints(...)` in the feature's `use` list). The app never lists its
 * features twice:
 *
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { http } from '@arki/http/dot';
 *
 * const app = await defineApp('shop-api')
 *   .use(db({ url }))
 *   .features([orders, billing])   // each declares `use: [endpoints(build)]`
 *   .serve(http({ port: 3000 }))
 *   .start();
 * ```
 *
 * Route bundles published as plain token services (not features) are
 * listed in `bundles`. Each becomes a need, so the builder's wiring guard
 * rejects the app at compile time unless an earlier unit provides it.
 * Bundle routes come first in the route table, then feature routes in
 * mount order.
 *
 * Lifecycle mapping — `.serve()` mounts after every feature, which is what
 * makes the drain order right:
 *
 *  - `boot`    — collect bundles, build the router, publish `httpServer`.
 *                NOT listening yet; all feature boots finish first.
 *  - `start`   — listen (first among starts — the route table is final).
 *  - `stop`    — stop accepting, drain in-flight handlers
 *                (`drainTimeoutMs`). Reverse order puts this FIRST:
 *                ingress stops before features tear down.
 *  - `dispose` — sever remaining connections (open SSE streams end here)
 *                and release the port.
 *
 * `@arki/dot` is an OPTIONAL peer of `@arki/http`. Importing this adapter
 * without `@arki/dot` installed fails at module load — intentional: the
 * adapter only makes sense inside a DOT app.
 */
import type { Driver } from '@arki/dot/feature';
import type { DotConfigureContext, Token } from '@arki/dot/plugin';
import type { Lazy } from '@arki/ts';
import type { RouteBundle } from './bundle.js';
import type { ContractLike } from './contract.js';
import type { HttpMiddleware } from './engine.js';
/** A token publishing a {@link RouteBundle} — what `options.bundles` lists. */
export type BundleToken = Token<RouteBundle, string>;
/**
 * The service the `http()` plugin publishes. `fetch` is the composed handler
 * — also the unit-test seam: call the app without a socket. `port`/`url`
 * are defined once the app has started.
 */
export type HttpServer = {
    readonly fetch: (req: Request) => Promise<Response>;
    port(): number | undefined;
    url(): string | undefined;
    /** Requests currently being handled (streams count until their handler returns). */
    inflight(): number;
};
/** Services published by the http adapter. */
export type HttpServices = {
    readonly httpServer: HttpServer;
};
export type HttpOptions<TBundles extends readonly BundleToken[] = readonly []> = {
    /**
     * Port to listen on in `start`. `0` picks an ephemeral port. Pass a
     * THUNK to defer the read to `start` — declarations stay import-pure
     * (no env observation at module load), e.g. `http({ port: () => env.PORT })`.
     *
     * Unlike `kv()`, the whole options object cannot be thunked here:
     * `bundles` is declaration-time wiring (it shapes the adapter's needs),
     * so only runtime settings like `port` defer.
     */
    readonly port: Lazy<number>;
    readonly hostname?: string;
    /**
     * Bundle tokens to serve, in route-table order, ahead of the features'
     * routes. For bundles published as plain token services, not by a
     * feature. Each becomes a `needs` entry — the wiring guard rejects the
     * composition unless an earlier unit publishes it.
     */
    readonly bundles?: TBundles;
    /**
     * App-wide fetch-shaped middleware (first = outermost): CORS, request
     * logging, compression. For per-request values use bundle derivers —
     * they are typed into handler contexts; middleware is not.
     */
    readonly middleware?: readonly HttpMiddleware[];
    /** Milliseconds `stop` waits for in-flight requests. Default 10 000. */
    readonly drainTimeoutMs?: number;
};
/** Wire-needs record derived from the bundle tokens. */
export type BundleNeeds<TBundles extends readonly BundleToken[]> = {
    readonly [Tok in TBundles[number] as Tok extends Token<RouteBundle, infer K> ? K : never]: RouteBundle;
};
/**
 * Stable error codes thrown by the http plugin beyond the engine's own.
 * Exported so consumers and coding agents can match against them.
 */
export declare const HTTP_PLUGIN_ERROR_CODES: {
    /** A bundle token's service was missing from the boot context (erased composition only). */
    readonly bundleMissing: 'ARKI_HTTP_E008';
    /** A feature's `routes` slice is not a route bundle (hand-minted slice, not `endpoints()`). */
    readonly routesSliceInvalid: 'ARKI_HTTP_E010';
};
/**
 * The HTTP driving adapter. `.serve(http(...))` binds it to the app's
 * features; it serves the listed bundles plus every feature's `routes`
 * slice. See the module docs for the composition pattern and lifecycle.
 */
export declare function http<const TBundles extends readonly BundleToken[] = readonly []>(options: HttpOptions<TBundles>): Driver<BundleNeeds<TBundles>, HttpServices>;
/**
 * Deprecated shim for registering contracts from a feature plugin's `configure`
 * hook. Prefer declaring contracts directly in `actions: [...]` on the plugin.
 * Converts zod schemas to JSON Schema once, at configure time, so
 * `dot explain --as openapi` renders without booting:
 *
 * ```ts
 * configure(ctx) {
 *   registerRoutes(ctx, [listOrders, createOrder, progress]);
 * }
 * ```
 */
export declare function registerRoutes(ctx: DotConfigureContext, contracts: readonly ContractLike[]): void;
//# sourceMappingURL=dot.d.ts.map