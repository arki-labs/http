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

import type { DotConfigureContext, EmptyShape, Pip, Token } from '@arki/dot/pip';
import { DotPipError, pip } from '@arki/dot/pip';

import type { RouteBundle } from './bundle.js';
import type { ContractLike } from './contract.js';
import type { HttpMiddleware } from './engine.js';
import type { ListenHandle } from './listen.js';
import { buildEngine, composeMiddleware } from './engine.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import { listen } from './listen.js';
import { contractMeta } from './openapi.js';

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
export const HTTP_PIP_ERROR_CODES = {
  /** A bundle token's service was missing from the boot context (erased composition only). */
  bundleMissing: 'ARKI_HTTP_E008',
} as const;

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

type PipState = {
  tracked: ((req: Request) => Promise<Response>) | undefined;
  handle: ListenHandle | undefined;
};

type InflightGauge = {
  count: number;
  waiters: (() => void)[];
};

function drained(gauge: InflightGauge, timeoutMs: number): Promise<void> {
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

function displayHost(hostname: string): string {
  return hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname;
}

/**
 * Build the DOT pip that serves the given bundles. See the module docs
 * for the composition pattern and lifecycle mapping.
 */
export function http<const TBundles extends readonly BundleToken[]>(
  options: HttpOptions<TBundles>,
): Pip<BundleNeeds<TBundles>, HttpServices> {
  const needs: Record<string, BundleToken> = {};
  for (const tok of options.bundles) {
    if (needs[tok.key] !== undefined) {
      throw new HttpConfigError({
        code: HTTP_ERROR_CODES.duplicateRoute,
        message: `[http] bundle token "${tok.key}" is listed twice in options.bundles.`,
        remediation: 'List each bundle token once. To mount one bundle at two places, rename the publishing pip.',
      });
    }
    needs[tok.key] = tok;
  }

  const state: PipState = { tracked: undefined, handle: undefined };
  const gauge: InflightGauge = { count: 0, waiters: [] };

  const inner = pip<EmptyShape, HttpServices>({
    name: 'http',
    version: '0.0.1',
    // Compile-time/runtime seam: the precise needs shape is derived from
    // `options.bundles` in the return-type cast below; here the runtime
    // record rides in under the EmptyShape default. The kernel re-checks
    // satisfaction at boot (DOT_LIFECYCLE_E012) for erased composition.
    needs,
    configure(ctx) {
      ctx.registerService('httpServer', 'custom');
    },
    boot(ctx) {
      // Erasure boundary: needs were declared dynamically above, so the
      // typed hook context can't know the bundle keys — the tokens do.
      const record = ctx as unknown as Readonly<Record<string, RouteBundle | undefined>>;
      const bundles: RouteBundle[] = [];
      for (const tok of options.bundles) {
        const bundle = record[tok.key];
        if (bundle === undefined) {
          throw new DotPipError({
            code: HTTP_PIP_ERROR_CODES.bundleMissing,
            message: `[http] bundle "${tok.key}" was not provided by any earlier pip.`,
            remediation:
              'Mount the pip that publishes this bundle before http(...). The typed builder enforces this; erased composition reaches this check.',
            docsUrl: 'https://arki.dev/http/errors/arki-http-e008',
          });
        }
        bundles.push(bundle);
      }

      const engine = buildEngine(bundles);
      const composed = composeMiddleware(engine.fetch, options.middleware ?? []);
      const tracked = async (req: Request): Promise<Response> => {
        gauge.count += 1;
        try {
          return await composed(req);
        } finally {
          gauge.count -= 1;
          if (gauge.count === 0) {
            const waiters = gauge.waiters.splice(0);
            for (const waiter of waiters) waiter();
          }
        }
      };
      state.tracked = tracked;

      const httpServer: HttpServer = {
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
        throw new DotPipError({
          code: HTTP_PIP_ERROR_CODES.bundleMissing,
          message: '[http] start ran without a booted engine — kernel contract violation.',
          remediation: 'This should be unreachable; boot always precedes start. Report it.',
          docsUrl: 'https://arki.dev/http/errors/arki-http-e008',
        });
      }
      state.handle = await listen(tracked, {
        port: options.port,
        ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
      });
    },
    async stop() {
      const handle = state.handle;
      if (handle === undefined) return;
      handle.stopAccepting();
      const timeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      try {
        await drained(gauge, timeoutMs);
        state.handle = undefined;
      } catch {
        const remaining = gauge.count;
        handle.forceClose();
        state.handle = undefined;
        throw new DotPipError({
          code: HTTP_ERROR_CODES.drainTimeout,
          message: `[http] ${String(remaining)} request(s) still in flight after the ${String(timeoutMs)}ms drain budget — connections were severed.`,
          remediation:
            'Long-running handlers or streams outlived the drain budget. Raise drainTimeoutMs on http(...), or make handlers respect ctx.signal.',
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

  // Erasure seam: `inner` is Pip<{}, HttpServices> because the needs shape
  // was runtime-built; the cast re-attaches the token-derived needs so the
  // app builder's guard checks bundle provision. Same seam as rename()/
  // testPip() in the kernel.
  return inner as unknown as Pip<BundleNeeds<TBundles>, HttpServices>;
}

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
export function registerRoutes(ctx: DotConfigureContext, contracts: readonly ContractLike[]): void {
  for (const contract of contracts) ctx.registerRoute(contractMeta(contract));
}
