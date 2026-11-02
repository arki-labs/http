/**
 * DOT adapter for `@arki/http` — the `http()` entrypoint.
 *
 * `http()` is an entrypoint: `.entrypoints(http(...))` binds it to the features the
 * app mounted, and it serves every feature's `routes` slice — declared with
 * `endpoints(core, build)` from this module in a `defineFeature` feature's
 * `.entrypoints(...)`. The app never lists its features twice:
 *
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { http } from '@arki/http/dot';
 *
 * const app = await defineApp('shop-api')
 *   .infra(db({ url }))
 *   .features([orders, billing])   // each lists `endpoints(core, build)` in `.entrypoints(...)`
 *   .entrypoints(http({ port: 3000 }))
 *   .start();
 * ```
 *
 * Route bundles published as plain token services (not features) are
 * listed in `bundles`. Each becomes a need, so the builder's wiring guard
 * rejects the app at compile time unless an earlier unit provides it.
 * Bundle routes come first in the route table, then feature routes in
 * mount order.
 *
 * Lifecycle mapping — `.entrypoints()` mounts after every feature, which is what
 * makes the drain order right:
 *
 *  - `provides.httpServer` — collect bundles, build the router, publish `httpServer`.
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
import type { AnyFeatureCore, EntrypointBinder, EntrypointServicesOf } from '@arki/dot/feature';
import type { Deferred, DotConfigureContext, Token } from '@arki/dot/unit';
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
    readonly port: Deferred<number>;
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
     * logging, compression. For per-request values use bundle steps —
     * they are typed into handler contexts; middleware is not.
     */
    readonly middleware?: readonly HttpMiddleware[];
    /**
     * Run every request inside the ambient store so `requestContext()`
     * (`@arki/http/context`) works. Off by default; it costs every request.
     */
    readonly requestContext?: boolean;
    /** Milliseconds `stop` waits for in-flight requests. Default 10 000. */
    readonly drainTimeoutMs?: number;
    /**
     * Where a feature INSTANCE's routes live (`feature.instance('eu', …)`):
     * `(instance, path)` maps a route, mount or rpc path written once in the
     * feature to the path served for that copy. Default puts the copy under
     * `/<instance>` (`GET /reports` -> `GET /eu/reports`; `/` -> `/eu`).
     * Plain features are never rewritten.
     */
    readonly instancePath?: (instance: string, path: string) => string;
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
    /**
     * A bundle token service was missing from the boot context (erased composition only).
     *
     * @fix Provide the service in the plugin that the route bundle needs.
     * @verify bun run test -- src/tests/bundle.test.ts
     */
    readonly bundleMissing: 'ARKI_HTTP_E008';
    /**
     * A feature `routes` slice is not a route bundle (a hand-made slice, not `endpoints()`).
     *
     * @fix Build the slice with `endpoints()`.
     * @verify bun run test -- src/tests/dot.test.ts
     */
    readonly routesSliceInvalid: 'ARKI_HTTP_E010';
};
/** What `endpoints(core, build)` hands `.entrypoints(...)`: the feature's route bundle, built at its boot. */
export type EndpointsEntrypoint<TServices> = {
    readonly kind: 'routes';
    readonly key: 'routes';
    /** The route contracts, for the manifest and `dot explain` — known before anything boots. */
    readonly actions: readonly ContractLike[];
    readonly resolve: (services: TServices) => RouteBundle;
};
/**
 * Declare a `defineFeature` feature's HTTP surface, in its `.entrypoints(...)`.
 * `build` runs once, at the feature's boot, with what every entrypoint gets —
 * the feature's `usecases` and its `entrypointOnly(...)` needs — typed from the
 * core at any stage, so a routes file of its own needs no annotation:
 *
 * ```ts
 * // entrypoints/routes.ts — `import type { core }` only
 * export const orderRoutes = (c: typeof core) =>
 *   endpoints(c, ({ usecases }) => routes().bind(listOrders, () => usecases.list()), { contracts: [listOrders] });
 * ```
 *
 * `contracts` are the route contracts the bundle binds; they join the
 * manifest as the feature's actions (a chain feature has no `actions` list
 * of its own). The `.entrypoints(http(...))` entrypoint collects the bundle under
 * `routes`.
 */
export declare function endpoints<C extends AnyFeatureCore>(_core: C, build: (services: EntrypointServicesOf<C>) => RouteBundle, options?: {
    readonly contracts?: readonly ContractLike[];
}): EndpointsEntrypoint<EntrypointServicesOf<C>>;
/**
 * The HTTP entrypoint. `.entrypoints(http(...))` binds it to the app's
 * features; it serves the listed bundles plus every feature's `routes`
 * slice. See the module docs for the composition pattern and lifecycle.
 */
export declare function http<const TBundles extends readonly BundleToken[] = readonly []>(options: HttpOptions<TBundles>): EntrypointBinder<BundleNeeds<TBundles>, HttpServices>;
/**
 * Deprecated shim for registering contracts from a feature plugin's `configure`
 * hook. Prefer declaring contracts directly in `actions: [...]` on the plugin.
 * Converts contract schemas to JSON Schema once, at configure time, so
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