/**
 * The socket layer — runtime-adaptive listening.
 *
 * `Bun.serve` when the Bun global is present, `@hono/node-server`
 * otherwise. Neither runtime's types leak into the public surface; the
 * handle exposes exactly what the `http()` pip's lifecycle needs.
 */

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
  serve(options: { readonly port: number; readonly hostname?: string; readonly fetch: FetchLike }): BunServerLike;
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

export async function listen(fetch: FetchLike, options: ListenOptions): Promise<ListenHandle> {
  const bun = bunGlobal();
  if (bun !== undefined) return listenBun(bun, fetch, options);
  return listenNode(fetch, options);
}

function listenBun(bun: BunGlobalLike, fetch: FetchLike, options: ListenOptions): ListenHandle {
  let server: BunServerLike;
  try {
    server = bun.serve({
      port: options.port,
      fetch,
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
