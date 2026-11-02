/**
 * The socket layer — runtime-adaptive listening.
 *
 * `Bun.serve` when the Bun global is present (with the engine's native
 * route table, when it has one), `@hono/node-server` otherwise. Neither runtime's types leak into the public surface; the
 * handle exposes exactly what the `http()` plugin's lifecycle needs.
 */

import type { BunRoutes, Engine } from './engine.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';

export type ListenOptions = {
  readonly port: number;
  readonly hostname?: string;
};

export type ListenHandle = {
  readonly port: number;
  readonly hostname: string;
  /** Stop accepting new connections; in-flight requests continue. */
  stopAccepting(): void;
  /** Sever remaining connections and release the port. */
  forceClose(): void;
};

type FetchLike = (req: Request) => Response | Promise<Response>;

type BunServerLike = {
  readonly port: number;
  readonly hostname: string;
  stop(closeActiveConnections?: boolean): void;
};

type BunGlobalLike = {
  serve(options: {
    readonly port: number;
    readonly hostname?: string;
    readonly fetch: FetchLike;
    readonly routes?: BunRoutes;
  }): BunServerLike;
};

/** Narrow structural view of the Bun global — `@types/node` has no Bun. */
function bunGlobal(): BunGlobalLike | undefined {
  return (globalThis as { Bun?: BunGlobalLike }).Bun;
}

function listenFailure(port: number, cause: unknown): HttpConfigError {
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
export async function listen(target: Engine | FetchLike, options: ListenOptions): Promise<ListenHandle> {
  const fetch = typeof target === 'function' ? target : target.fetch;
  const routes = typeof target === 'function' ? undefined : target.bunRoutes;
  const bun = bunGlobal();
  if (bun !== undefined) return listenBun(bun, fetch, routes, options);
  return listenNode(fetch, options);
}

function listenBun(
  bun: BunGlobalLike,
  fetch: FetchLike,
  routes: BunRoutes | undefined,
  options: ListenOptions,
): ListenHandle {
  let server: BunServerLike;
  try {
    server = bun.serve({
      port: options.port,
      fetch,
      ...(routes === undefined ? {} : { routes }),
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    });
  } catch (error) {
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

async function listenNode(fetch: FetchLike, options: ListenOptions): Promise<ListenHandle> {
  const { serve } = await import('@hono/node-server');
  return await new Promise<ListenHandle>((resolve, reject) => {
    const server = serve({ fetch, port: options.port, hostname: options.hostname ?? '0.0.0.0' }, info => {
      resolve({
        port: info.port,
        hostname: info.address,
        stopAccepting: () => {
          server.close();
        },
        forceClose: () => {
          const closable = server as { close(): unknown; closeAllConnections?(): void };
          closable.closeAllConnections?.();
          closable.close();
        },
      });
    });
    server.on('error', (error: unknown) => {
      reject(listenFailure(options.port, error));
    });
  });
}
