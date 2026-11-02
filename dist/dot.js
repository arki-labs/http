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
import { entrypoint, handlerObserverOf, instanceOf, sliceOf } from '@arki/dot/feature';
import { DotUnitError, resolveDeferred } from '@arki/dot/unit';
import { buildEngine } from './compiled.js';
import { composeMiddleware } from './engine.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import { listen } from './listen.js';
const defaultInstancePath = (instance, path) => path === '/' ? `/${instance}` : `/${instance}${path}`;
/** The same bundle with every route, mount and rpc path moved by `place`. */
function placeBundle(bundle, place) {
    return {
        ...bundle,
        bindings: bundle.bindings.map(binding => ({
            ...binding,
            contract: { ...binding.contract, path: place(binding.contract.path) },
        })),
        mounts: bundle.mounts.map(mount => ({ ...mount, path: place(mount.path) })),
        ...(bundle.rpcs === undefined ? {} : { rpcs: bundle.rpcs.map(rpc => placeRpc(rpc, place)) }),
    };
}
/**
 * An rpc handler matches its OWN prefix (the one written in the feature), but
 * `replaceRequest: false` hands it the original URL, so the instance prefix
 * is stripped back off before `context`/`handle` see the request.
 */
function placeRpc(rpc, place) {
    const placed = place(rpc.path);
    const unplace = (req) => {
        const url = new URL(req.url);
        if (url.pathname !== placed && !url.pathname.startsWith(`${placed}/`))
            return req;
        url.pathname = rpc.path + url.pathname.slice(placed.length);
        return new Request(url, req);
    };
    return {
        ...rpc,
        path: placed,
        context: (req, ctx) => rpc.context(unplace(req), ctx),
        handle: (req, ctx) => rpc.handle(unplace(req), ctx),
    };
}
/**
 * Stable error codes thrown by the http plugin beyond the engine's own.
 * Exported so consumers and coding agents can match against them.
 */
export const HTTP_PLUGIN_ERROR_CODES = {
    /**
     * A bundle token service was missing from the boot context (erased composition only).
     *
     * @fix Provide the service in the plugin that the route bundle needs.
     * @verify bun run test -- src/tests/bundle.test.ts
     */
    bundleMissing: 'ARKI_HTTP_E008',
    /**
     * A feature `routes` slice is not a route bundle (a hand-made slice, not `endpoints()`).
     *
     * @fix Build the slice with `endpoints()`.
     * @verify bun run test -- src/tests/dot.test.ts
     */
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
function observeWith(observer, ref) {
    return { watching: observer.watching, run: (work, failureOf) => observer.run(ref, work, { returned: failureOf }) };
}
/**
 * The same bundle with every route and rpc mount bracketed by the feature's
 * handler observer, named as the manifest names its action (`METHOD /path`;
 * a mount's path). Only a Dot feature goes through here, so a bundle used
 * without Dot carries no observer at all.
 */
function observedBundle(bundle, services) {
    // A bag that is not an object (a hand-made test value) has no observer: serve the bundle as is.
    if (typeof services !== 'object' || services === null)
        return bundle;
    const observer = handlerObserverOf(services);
    return {
        ...bundle,
        bindings: bundle.bindings.map(binding => {
            const ref = { transport: 'http', name: `${binding.contract.method} ${binding.contract.path}` };
            return { ...binding, observe: observeWith(observer, ref) };
        }),
        ...(bundle.rpcs === undefined
            ? {}
            : {
                rpcs: bundle.rpcs.map(rpc => {
                    const ref = { transport: 'http', name: rpc.path };
                    return { ...rpc, observe: observeWith(observer, ref) };
                }),
            }),
    };
}
function isRouteBundle(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'stages' in value &&
        Array.isArray(value.stages) &&
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
        throw new DotUnitError({
            code: HTTP_PLUGIN_ERROR_CODES.routesSliceInvalid,
            message: `[http] feature "${f.name}" published a "routes" slice that is not a route bundle.`,
            remediation: "Declare the feature's HTTP surface with endpoints(core, build) from @arki/http/dot, where build returns routes()….",
            docsUrl: 'https://arki.dev/http/errors/arki-http-e010',
        });
    }
    return routes;
}
function displayHost(hostname) {
    return hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname;
}
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
export function endpoints(_core, build, options = {}) {
    // `_core` is a type witness: the feature hands its own services to `resolve` when it boots.
    return {
        kind: 'routes',
        key: 'routes',
        actions: options.contracts ?? [],
        resolve: services => observedBundle(build(services), services),
    };
}
/**
 * The HTTP entrypoint. `.entrypoints(http(...))` binds it to the app's
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
    // Erasure seam: the bound unit has `{}` needs because its needs record is
    // runtime-built; the cast re-attaches the token-derived needs so the
    // builder's guard checks bundle provision at `.entrypoints()`.
    // Same seam as rename()/testUnit() in the kernel.
    return httpFromFeatures(options, bundleTokens, needs);
}
function httpFromFeatures(options, bundleTokens, needs) {
    return entrypoint.fromFeatures({
        name: 'http',
        // One app's server: each app that mounts this binder listens on its own.
        state: () => ({ served: undefined, handle: undefined, gauge: { count: 0, waiters: [] } }),
        // Compile-time/runtime seam: the precise needs shape is derived from
        // `options.bundles` in http()'s return-type cast; here the runtime
        // record rides in under the EmptyShape default. The kernel re-checks
        // satisfaction at boot (DOT_LIFECYCLE_E012) for erased composition.
        // `.entrypoints()` adds the features' slice tokens to these needs.
        needs,
        configure(ctx) {
            ctx.registerService('httpServer', 'custom');
            ctx.registerProjection({ format: 'openapi', binding: 'http', module: '@arki/http/projection' });
        },
        provides: {
            httpServer: ctx => {
                // Erasure boundary: needs were declared dynamically above, so the
                // typed hook context can't know the bundle keys — the tokens do.
                // Bundles first, then feature routes in mount order.
                const record = ctx;
                const bundles = [];
                for (const tok of bundleTokens) {
                    const bundle = record[tok.key];
                    if (bundle === undefined) {
                        throw new DotUnitError({
                            code: HTTP_PLUGIN_ERROR_CODES.bundleMissing,
                            message: `[http] bundle "${tok.key}" was not provided by any earlier plugin.`,
                            remediation: 'Mount the plugin that publishes this bundle before http(...). The typed builder enforces this; erased composition reaches this check.',
                            docsUrl: 'https://arki.dev/http/errors/arki-http-e008',
                        });
                    }
                    bundles.push(bundle);
                }
                for (const f of ctx.$features) {
                    const routes = featureRoutes(ctx, f);
                    if (routes === undefined)
                        continue;
                    const instance = instanceOf(f.name);
                    bundles.push(instance === undefined
                        ? routes
                        : placeBundle(routes, path => (options.instancePath ?? defaultInstancePath)(instance, path)));
                }
                // The gauge is the outermost layer, so drain-on-shutdown counts every
                // request, including those Bun matches natively.
                const { $state: state } = ctx;
                const gauge = state.gauge;
                const tracking = async (req, next) => {
                    gauge.count += 1;
                    try {
                        return await next(req);
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
                const engine = buildEngine(bundles, { requestContext: options.requestContext === true });
                const served = composeMiddleware(engine, [tracking, ...(options.middleware ?? [])]);
                state.served = served;
                const httpServer = {
                    fetch: served.fetch,
                    port: () => state.handle?.port,
                    url: () => {
                        const handle = state.handle;
                        return handle === undefined ? undefined : `http://${displayHost(handle.hostname)}:${String(handle.port)}`;
                    },
                    inflight: () => gauge.count,
                };
                return httpServer;
            },
        },
        async start({ $state: state }) {
            const served = state.served;
            if (served === undefined) {
                throw new DotUnitError({
                    code: HTTP_PLUGIN_ERROR_CODES.bundleMissing,
                    message: '[http] start ran without a booted engine — kernel contract violation.',
                    remediation: 'This should be unreachable; boot always precedes start. Report it.',
                    docsUrl: 'https://arki.dev/http/errors/arki-http-e008',
                });
            }
            state.handle = await listen(served, {
                port: resolveDeferred(options.port),
                ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
            });
        },
        async stop({ $state: state }) {
            const handle = state.handle;
            if (handle === undefined)
                return;
            handle.stopAccepting();
            const timeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
            try {
                await drained(state.gauge, timeoutMs);
                state.handle = undefined;
            }
            catch {
                const remaining = state.gauge.count;
                handle.forceClose();
                state.handle = undefined;
                throw new DotUnitError({
                    code: HTTP_ERROR_CODES.drainTimeout,
                    message: `[http] ${String(remaining)} request(s) still in flight after the ${String(timeoutMs)}ms drain budget — connections were severed.`,
                    remediation: 'Long-running handlers or streams outlived the drain budget. Raise drainTimeoutMs on http(...), or make handlers respect ctx.signal.',
                    docsUrl: 'https://arki.dev/http/errors/arki-http-e005',
                });
            }
        },
        dispose({ $state: state }) {
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
 * Converts contract schemas to JSON Schema once, at configure time, so
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