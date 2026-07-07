/**
 * DOT adapter for `@arki/http` — the `http()` pip.
 *
 * Mount it LAST. Feature pips publish {@link RouteBundle}s as token
 * services in their `boot`; `http()` derives its `needs` from the tokens
 * you pass, so the app builder's wiring guard enforces — at compile time —
 * that every listed bundle is provided by an earlier pip:
 *
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { http } from '@arki/http/dot';
 *
 * const app = await defineApp('shop-api')
 *   .use(db({ url }))
 *   .use(ordersPip)          // publishes OrdersRoutes
 *   .use(billingPip)         // publishes BillingRoutes
 *   .use(http({ port: 3000, bundles: [OrdersRoutes, BillingRoutes] }))
 *   .start();
 * ```
 *
 * Lifecycle mapping — mounting last is what makes the drain order right:
 *
 *  - `boot`    — collect bundles, build the router, publish `httpServer`.
 *                NOT listening yet; all feature boots finish first.
 *  - `start`   — listen (first among starts — the route table is final).
 *  - `stop`    — stop accepting, drain in-flight handlers
 *                (`drainTimeoutMs`). Reverse order puts this FIRST:
 *                ingress stops before feature pips tear down.
 *  - `dispose` — sever remaining connections (open SSE streams end here)
 *                and release the port.
 *
 * `@arki/dot` is an OPTIONAL peer of `@arki/http`. Importing this adapter
 * without `@arki/dot` installed fails at module load — intentional: the
 * adapter only makes sense inside a DOT app.
 */
import type { DotConfigureContext, Pip, Token } from '@arki/dot/pip';
import type { RouteBundle } from './bundle.js';
import type { ContractLike } from './contract.js';
import type { HttpMiddleware } from './engine.js';
/** A token publishing a {@link RouteBundle} — what `options.bundles` lists. */
export type BundleToken = Token<RouteBundle, string>;
/**
 * The service the `http()` pip publishes. `fetch` is the composed handler
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
export type HttpOptions<TBundles extends readonly BundleToken[]> = {
    /** Port to listen on in `start`. `0` picks an ephemeral port. */
    readonly port: number;
    readonly hostname?: string;
    /**
     * Bundle tokens to serve, in route-table order. Each becomes a `needs`
     * entry — the wiring guard rejects the composition unless an earlier
     * pip publishes it.
     */
    readonly bundles: TBundles;
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
 * Stable error codes thrown by the http pip beyond the engine's own.
 * Exported so consumers and coding agents can match against them.
 */
export declare const HTTP_PIP_ERROR_CODES: {
    /** A bundle token's service was missing from the boot context (erased composition only). */
    readonly bundleMissing: "ARKI_HTTP_E008";
};
/**
 * Build the DOT pip that serves the given bundles. See the module docs
 * for the composition pattern and lifecycle mapping.
 */
export declare function http<const TBundles extends readonly BundleToken[]>(options: HttpOptions<TBundles>): Pip<BundleNeeds<TBundles>, HttpServices>;
/**
 * Register contracts in the DOT manifest from a feature pip's `configure`
 * hook. Converts zod schemas to JSON Schema once, at configure time, so
 * `dot explain --openapi` renders without booting:
 *
 * ```ts
 * configure(ctx) {
 *   registerRoutes(ctx, [listOrders, createOrder, progress]);
 * }
 * ```
 */
export declare function registerRoutes(ctx: DotConfigureContext, contracts: readonly ContractLike[]): void;
//# sourceMappingURL=dot.d.ts.map