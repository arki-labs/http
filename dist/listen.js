/**
 * The socket layer — runtime-adaptive listening.
 *
 * `Bun.serve` when the Bun global is present (with the engine's native
 * route table, when it has one), `@hono/node-server` otherwise. Neither runtime's types leak into the public surface; the
 * handle exposes exactly what the `http()` plugin's lifecycle needs.
 */
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
/** Narrow structural view of the Bun global — `@types/node` has no Bun. */
function bunGlobal() {
    return globalThis.Bun;
}
function listenFailure(port, cause) {
    return new HttpConfigError({
        code: HTTP_ERROR_CODES.listenFailed,
        message: `[http] failed to listen on port ${port}: ${cause instanceof Error ? cause.message : String(cause)}`,
        remediation: 'Is the port already in use? Change options.port on http(...) or stop the other process.',
    });
}
/**
 * Serve an engine, or a bare fetch handler. Under Bun an engine's
 * `bunRoutes` go to `Bun.serve({ routes })`, so those routes are matched
 * natively; everything else reaches `fetch`.
 */
export async function listen(target, options) {
    const fetch = typeof target === 'function' ? target : target.fetch;
    const routes = typeof target === 'function' ? undefined : target.bunRoutes;
    const bun = bunGlobal();
    if (bun !== undefined)
        return listenBun(bun, fetch, routes, options);
    return listenNode(fetch, options);
}
function listenBun(bun, fetch, routes, options) {
    let server;
    try {
        server = bun.serve({
            port: options.port,
            fetch,
            ...(routes === undefined ? {} : { routes }),
            ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
        });
    }
    catch (error) {
        throw listenFailure(options.port, error);
    }
    return {
        port: server.port,
        hostname: server.hostname,
        stopAccepting: () => {
            server.stop(false);
        },
        forceClose: () => {
            server.stop(true);
        },
    };
}
async function listenNode(fetch, options) {
    const { serve } = await import('@hono/node-server');
    return await new Promise((resolve, reject) => {
        const server = serve({ fetch, port: options.port, hostname: options.hostname ?? '0.0.0.0' }, info => {
            resolve({
                port: info.port,
                hostname: info.address,
                stopAccepting: () => {
                    server.close();
                },
                forceClose: () => {
                    const closable = server;
                    closable.closeAllConnections?.();
                    closable.close();
                },
            });
        });
        server.on('error', (error) => {
            reject(listenFailure(options.port, error));
        });
    });
}
//# sourceMappingURL=listen.js.map