/**
 * DOT adapter for `@arki/http` — the `http()` plugin.
 *
 * Mount it LAST. Feature plugins publish {@link RouteBundle}s as token
 * services in their `boot`; `http()` derives its `needs` from the tokens
 * you pass, so the app builder's wiring guard enforces — at compile time —
 * that every listed bundle is provided by an earlier plugin:
 *
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { http } from '@arki/http/dot';
 *
 * const app = await defineApp('shop-api')
 *   .use(db({ url }))
 *   .use(ordersPlugin)          // publishes OrdersRoutes
 *   .use(billingPlugin)         // publishes BillingRoutes
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
 *                ingress stops before feature plugins tear down.
 *  - `dispose` — sever remaining connections (open SSE streams end here)
 *                and release the port.
 *
 * `@arki/dot` is an OPTIONAL peer of `@arki/http`. Importing this adapter
 * without `@arki/dot` installed fails at module load — intentional: the
 * adapter only makes sense inside a DOT app.
 */
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
    /** A bundle or feature token's service was missing from the boot context (erased composition only). */
    bundleMissing: 'ARKI_HTTP_E008',
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
function displayHost(hostname) {
    return hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname;
}
/**
 * Build the DOT plugin that serves the given bundles. See the module docs
 * for the composition pattern and lifecycle mapping.
 */
export function http(options) {
    const bundleTokens = options.bundles ?? [];
    const featureTokens = options.features ?? [];
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
    for (const tok of featureTokens) {
        if (needs[tok.key] !== undefined) {
            throw new HttpConfigError({
                code: HTTP_ERROR_CODES.duplicateRoute,
                message: `[http] feature token "${tok.key}" is listed twice in options.features or duplicates a bundle token.`,
                remediation: 'List each feature token once. To mount one feature twice, rename the publishing plugin.',
            });
        }
        needs[tok.key] = tok;
    }
    const state = { tracked: undefined, handle: undefined };
    const gauge = { count: 0, waiters: [] };
    const inner = plugin({
        name: 'http',
        version: '0.0.1',
        // Compile-time/runtime seam: the precise needs shape is derived from
        // `options.bundles` in the return-type cast below; here the runtime
        // record rides in under the EmptyShape default. The kernel re-checks
        // satisfaction at boot (DOT_LIFECYCLE_E012) for erased composition.
        needs,
        configure(ctx) {
            ctx.registerService('httpServer', 'custom');
            ctx.registerProjection({ format: 'openapi', binding: 'http', module: '@arki/http/projection' });
        },
        boot(ctx) {
            // Erasure boundary: needs were declared dynamically above, so the
            // typed hook context can't know the bundle keys — the tokens do.
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
            for (const tok of featureTokens) {
                const slice = record[tok.key];
                if (slice === undefined) {
                    throw new DotPluginError({
                        code: HTTP_PLUGIN_ERROR_CODES.bundleMissing,
                        message: `[http] feature "${tok.key}" was not provided by any earlier plugin.`,
                        remediation: 'Mount the feature plugin that publishes this token before http(...). The typed builder enforces this; erased composition reaches this check.',
                        docsUrl: 'https://arki.dev/http/errors/arki-http-e008',
                    });
                }
                if (slice.routes !== undefined) {
                    bundles.push(slice.routes);
                }
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
    // Erasure seam: `inner` is Plugin<{}, HttpServices> because the needs shape
    // was runtime-built; the cast re-attaches the token-derived needs so the
    // app builder's guard checks bundle provision. Same seam as rename()/
    // testPlugin() in the kernel.
    return inner;
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