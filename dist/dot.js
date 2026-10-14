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
import { driver, sliceOf } from '@arki/dot/feature';
import { DotPluginError, plugin } from '@arki/dot/plugin';
import { resolveLazy } from '@arki/ts';
import { buildEngine, composeMiddleware } from './engine.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import { listen } from './listen.js';
/**
 * Stable error codes thrown by the http plugin beyond the engine's own.
 * Exported so consumers and coding agents can match against them.
 */
export const HTTP_PLUGIN_ERROR_CODES = {
    /** A bundle token's service was missing from the boot context (erased composition only). */
    bundleMissing: 'ARKI_HTTP_E008',
    /** A feature's `routes` slice is not a route bundle (hand-minted slice, not `endpoints()`). */
    routesSliceInvalid: 'ARKI_HTTP_E010',
};
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
function drained(gauge, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (gauge.count === 0) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            reject(new Error(`drain timeout after ${String(timeoutMs)}ms`));
        }, timeoutMs);
        timer.unref();
        gauge.waiters.push(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}
function isRouteBundle(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'derivers' in value &&
        Array.isArray(value.derivers) &&
        'bindings' in value &&
        Array.isArray(value.bindings) &&
        'mounts' in value &&
        Array.isArray(value.mounts));
}
/** The `routes` slice of one mounted feature, or `undefined` when it declares none. */
function featureRoutes(ctx, f) {
    const routes = sliceOf(ctx, f)['routes'];
    if (routes === undefined)
        return undefined;
    if (!isRouteBundle(routes)) {
        throw new DotPluginError({
            code: HTTP_PLUGIN_ERROR_CODES.routesSliceInvalid,
            message: `[http] feature "${f.name}" published a "routes" slice that is not a route bundle.`,
            remediation: 'Declare the feature\'s HTTP surface with endpoints(build) from @arki/http, where build returns routes()….',
            docsUrl: 'https://arki.dev/http/errors/arki-http-e010',
        });
    }
    return routes;
}
function displayHost(hostname) {
    return hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname;
}
/**
 * The HTTP driving adapter. `.serve(http(...))` binds it to the app's
 * features; it serves the listed bundles plus every feature's `routes`
 * slice. See the module docs for the composition pattern and lifecycle.
 */
export function http(options) {
    const bundleTokens = options.bundles ?? [];
    const needs = {};
    for (const tok of bundleTokens) {
        if (needs[tok.key] !== undefined) {
            throw new HttpConfigError({
                code: HTTP_ERROR_CODES.duplicateRoute,
                message: `[http] bundle token "${tok.key}" is listed twice in options.bundles.`,
                remediation: 'List each bundle token once. To mount one bundle at two places, rename the publishing plugin.',
            });
        }
        needs[tok.key] = tok;
    }
    // Erasure seam: the bound plugin is Plugin<{}, HttpServices> because its
    // needs record is runtime-built; the cast re-attaches the token-derived
    // needs so the builder's guard checks bundle provision at `.serve()`.
    // Same seam as rename()/testPlugin() in the kernel.
    return driver(features => bindHttp(options, bundleTokens, needs, features));
}
function bindHttp(options, bundleTokens, needs, features) {
    const state = { tracked: undefined, handle: undefined };
    const gauge = { count: 0, waiters: [] };
    return plugin({
        name: 'http',
        version: '0.0.1',
        // Compile-time/runtime seam: the precise needs shape is derived from
        // `options.bundles` in http()'s return-type cast; here the runtime
        // record rides in under the EmptyShape default. The kernel re-checks
        // satisfaction at boot (DOT_LIFECYCLE_E012) for erased composition.
        // `.serve()` adds the features' slice tokens to these needs.
        needs,
        configure(ctx) {
            ctx.registerService('httpServer', 'custom');
            ctx.registerProjection({ format: 'openapi', binding: 'http', module: '@arki/http/projection' });
        },
        boot(ctx) {
            // Erasure boundary: needs were declared dynamically above, so the
            // typed hook context can't know the bundle keys — the tokens do.
            // Bundles first, then feature routes in mount order.
            const record = ctx;
            const bundles = [];
            for (const tok of bundleTokens) {
                const bundle = record[tok.key];
                if (bundle === undefined) {
                    throw new DotPluginError({
                        code: HTTP_PLUGIN_ERROR_CODES.bundleMissing,
                        message: `[http] bundle "${tok.key}" was not provided by any earlier plugin.`,
                        remediation: 'Mount the plugin that publishes this bundle before http(...). The typed builder enforces this; erased composition reaches this check.',
                        docsUrl: 'https://arki.dev/http/errors/arki-http-e008',
                    });
                }
                bundles.push(bundle);
            }
            for (const f of features) {
                const routes = featureRoutes(ctx, f);
                if (routes !== undefined)
                    bundles.push(routes);
            }
            const engine = buildEngine(bundles);
            const composed = composeMiddleware(engine.fetch, options.middleware ?? []);
            const tracked = async (req) => {
                gauge.count += 1;
                try {
                    return await composed(req);
                }
                finally {
                    gauge.count -= 1;
                    if (gauge.count === 0) {
                        const waiters = gauge.waiters.splice(0);
                        for (const waiter of waiters)
                            waiter();
                    }
                }
            };
            state.tracked = tracked;
            const httpServer = {
                fetch: tracked,
                port: () => state.handle?.port,
                url: () => {
                    const handle = state.handle;
                    return handle === undefined
                        ? undefined
                        : `http://${displayHost(handle.hostname)}:${String(handle.port)}`;
                },
                inflight: () => gauge.count,
            };
            return { httpServer };
        },
        async start() {
            const tracked = state.tracked;
            if (tracked === undefined) {
                throw new DotPluginError({
                    code: HTTP_PLUGIN_ERROR_CODES.bundleMissing,
                    message: '[http] start ran without a booted engine — kernel contract violation.',
                    remediation: 'This should be unreachable; boot always precedes start. Report it.',
                    docsUrl: 'https://arki.dev/http/errors/arki-http-e008',
                });
            }
            state.handle = await listen(tracked, {
                port: resolveLazy(options.port),
                ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
            });
        },
        async stop() {
            const handle = state.handle;
            if (handle === undefined)
                return;
            handle.stopAccepting();
            const timeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
            try {
                await drained(gauge, timeoutMs);
                state.handle = undefined;
            }
            catch {
                const remaining = gauge.count;
                handle.forceClose();
                state.handle = undefined;
                throw new DotPluginError({
                    code: HTTP_ERROR_CODES.drainTimeout,
                    message: `[http] ${String(remaining)} request(s) still in flight after the ${String(timeoutMs)}ms drain budget — connections were severed.`,
                    remediation: 'Long-running handlers or streams outlived the drain budget. Raise drainTimeoutMs on http(...), or make handlers respect ctx.signal.',
                    docsUrl: 'https://arki.dev/http/errors/arki-http-e005',
                });
            }
        },
        dispose() {
            if (state.handle !== undefined) {
                state.handle.forceClose();
                state.handle = undefined;
            }
        },
    });
}
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
export function registerRoutes(ctx, contracts) {
    for (const contract of contracts)
        ctx.registerAction(contract.toDotAction());
}
//# sourceMappingURL=dot.js.map