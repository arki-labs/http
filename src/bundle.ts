/**
 * Route bundles — the dynamic half of an HTTP surface.
 *
 * A bundle binds contracts to handlers. It is assembled inside a pip's
 * `boot` hook — where the pip's `needs` are already injected — so handlers
 * and derivers close over typed singletons:
 *
 * ```ts
 * export const OrdersRoutes = token<RouteBundle>()('orders.routes');
 *
 * export const ordersPip = pip({
 *   name: 'orders',
 *   needs: { db: service<Db>() },
 *   configure(ctx) {
 *     registerRoutes(ctx, [listOrders, createOrder]); // from '@arki/http/dot'
 *   },
 *   async boot({ db }) {
 *     return provide(
 *       OrdersRoutes,
 *       routes()
 *         .bind(listOrders, async ({ query }) => db.orders.list(query))
 *         .bind(createOrder, async ({ body }, ctx) => db.orders.create(body, ctx.requestId)),
 *     );
 *   },
 * });
 * ```
 *
 * The builder accumulates deriver-added context keys in its type — a
 * handler bound after `.derive('principal', …)` sees `ctx.principal`
 * typed. Same accumulation idiom as `defineApp().use()`.
 */

import type { ContractLike, ParamsOf, RouteContract, SseContract } from './contract.js';
import type { BaseRequestCtx, Deriver, ErasedDeriver } from './derive.js';
import { BASE_CTX_KEYS } from './derive.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';

type MaybePromise<T> = T | Promise<T>;

/** The validated inputs a bound handler receives. */
export type RouteInput<TPath extends string, TQuery, TBody> = {
  readonly params: ParamsOf<TPath>;
  readonly query: TQuery;
  readonly body: TBody;
};

/**
 * What a JSON handler may return: the contract's output type (serialized
 * and validated), or a raw `Response` as the escape hatch — redirects,
 * files, custom streams. Contracts without an output schema must return
 * a `Response`.
 */
export type HandlerResult<TOutput> = [TOutput] extends [undefined] ? Response : TOutput | Response;

/** Handler signature inferred from a {@link RouteContract}. */
export type RouteHandler<TPath extends string, TQuery, TBody, TOutput, TCtx extends BaseRequestCtx> = (
  input: RouteInput<TPath, TQuery, TBody>,
  ctx: TCtx,
) => MaybePromise<HandlerResult<TOutput>>;

/**
 * Handler signature inferred from an {@link SseContract}: an async
 * iterable (usually an async generator) of events. Each yielded value is
 * validated against the contract's event schema and framed as an SSE
 * `data:` message. Client disconnect aborts `ctx.signal` and terminates
 * the iterator.
 */
export type SseHandler<TPath extends string, TQuery, TEvent, TCtx extends BaseRequestCtx> = (
  input: RouteInput<TPath, TQuery, undefined>,
  ctx: TCtx,
) => AsyncIterable<TEvent>;

/** Non-HTTP transports a {@link RouteBundleBuilder.mount} can declare. */
export type MountTransport = 'orpc' | 'trpc' | 'rpc' | 'custom';

export type MountMeta = {
  /** Stable identifier — lands in the manifest like a contract id. */
  readonly id: string;
  /** Manifest transport tag. Defaults to `'custom'`. */
  readonly transport?: MountTransport;
};

/** A contract bound to its (generics-erased) handler. */
export type RouteBinding = {
  readonly contract: ContractLike;
  /**
   * Stored erased (`never` parameters) — typed handlers are assignable
   * via parameter contravariance from the bottom type; the engine crosses
   * the erasure boundary at the call site. Mirrors the DOT kernel's
   * hook-storage pattern.
   */
  readonly handler: (input: never, ctx: never) => unknown;
};

/** A mounted foreign fetch handler (oRPC/tRPC router, static files, …). */
export type MountBinding = {
  readonly id: string;
  readonly path: string;
  readonly transport: MountTransport;
  readonly handler: (req: Request) => Response | Promise<Response>;
};

/**
 * A plain value: derivers + bound contracts + mounts. Published as an
 * ordinary DOT service under a token and collected by the `http()` pip —
 * no new kernel concept.
 */
export type RouteBundle = {
  readonly derivers: readonly ErasedDeriver[];
  readonly bindings: readonly RouteBinding[];
  readonly mounts: readonly MountBinding[];
};

/**
 * Immutable bundle builder. Every method returns a new builder; deriver
 * keys accumulate in `TCtx` so later `bind` handlers see them typed.
 */
export type RouteBundleBuilder<TCtx extends BaseRequestCtx = BaseRequestCtx> = RouteBundle & {
  /** Add a reusable deriver (see {@link Deriver}). */
  derive<K extends string, V>(deriver: Deriver<K, V, TCtx>): RouteBundleBuilder<TCtx & Readonly<Record<K, V>>>;
  /** Add an inline deriver. */
  derive<K extends string, V>(
    key: K,
    fn: (req: Request, ctx: TCtx) => V | Promise<V>,
  ): RouteBundleBuilder<TCtx & Readonly<Record<K, V>>>;
  /**
   * Bind a JSON contract to its handler. `NoInfer` pins the input/output
   * generics to the contract — without it, a handler returning the wrong
   * shape would silently widen `TOutput` instead of failing to compile.
   */
  bind<TPath extends string, TQuery, TBody, TOutput>(
    contract: RouteContract<TPath, TQuery, TBody, TOutput>,
    handler: RouteHandler<TPath, NoInfer<TQuery>, NoInfer<TBody>, NoInfer<TOutput>, TCtx>,
  ): RouteBundleBuilder<TCtx>;
  /** Bind an SSE contract to its event generator. */
  bind<TPath extends string, TQuery, TEvent>(
    contract: SseContract<TPath, TQuery, TEvent>,
    handler: SseHandler<TPath, NoInfer<TQuery>, NoInfer<TEvent>, TCtx>,
  ): RouteBundleBuilder<TCtx>;
  /**
   * Mount a foreign fetch handler under a path prefix — an oRPC router, a
   * tRPC fetch adapter, a static-file handler. One manifest route, no
   * schemas, derivers do NOT run for mounted handlers.
   */
  mount(
    path: string,
    handler: (req: Request) => Response | Promise<Response>,
    meta: MountMeta,
  ): RouteBundleBuilder<TCtx>;
};

type BundleState = {
  readonly derivers: readonly ErasedDeriver[];
  readonly bindings: readonly RouteBinding[];
  readonly mounts: readonly MountBinding[];
};

function assertFreshDeriverKey(key: string, existing: readonly ErasedDeriver[]): void {
  const reserved = (BASE_CTX_KEYS as readonly string[]).includes(key);
  const duplicate = existing.some(d => d.key === key);
  if (!reserved && !duplicate) return;
  throw new HttpConfigError({
    code: HTTP_ERROR_CODES.duplicateDeriverKey,
    message: reserved
      ? `[http] deriver key "${key}" shadows a base request-context key.`
      : `[http] deriver key "${key}" is already derived in this bundle.`,
    remediation: `Pick a different key — base keys (${BASE_CTX_KEYS.join(', ')}) and earlier deriver keys are reserved.`,
  });
}

function makeBuilder(state: BundleState): RouteBundleBuilder {
  const impl = {
    derivers: state.derivers,
    bindings: state.bindings,
    mounts: state.mounts,
    derive(keyOrDeriver: string | ErasedDeriver, fn?: (req: Request, ctx: never) => unknown): RouteBundleBuilder {
      let deriver: ErasedDeriver;
      if (typeof keyOrDeriver === 'string') {
        if (fn === undefined) {
          throw new HttpConfigError({
            code: HTTP_ERROR_CODES.duplicateDeriverKey,
            message: `[http] derive("${keyOrDeriver}") is missing its deriver function.`,
            remediation: 'Pass derive(key, fn) or derive(deriverObject).',
          });
        }
        deriver = { key: keyOrDeriver, derive: fn };
      } else {
        deriver = keyOrDeriver;
      }
      assertFreshDeriverKey(deriver.key, state.derivers);
      return makeBuilder({ ...state, derivers: [...state.derivers, deriver] });
    },
    bind(contract: ContractLike, handler: (input: never, ctx: never) => unknown): RouteBundleBuilder {
      return makeBuilder({ ...state, bindings: [...state.bindings, { contract, handler }] });
    },
    mount(path: string, handler: (req: Request) => Response | Promise<Response>, meta: MountMeta): RouteBundleBuilder {
      if (!path.startsWith('/') || path.includes(' ')) {
        throw new HttpConfigError({
          code: HTTP_ERROR_CODES.invalidMount,
          message: `[http] mount path "${path}" is invalid — it must start with "/" and contain no spaces.`,
          remediation: 'Mount under an absolute path prefix, e.g. mount("/rpc", handler, { id: "rpc" }).',
        });
      }
      return makeBuilder({
        ...state,
        mounts: [...state.mounts, { id: meta.id, path, transport: meta.transport ?? 'custom', handler }],
      });
    },
  };
  // Erasure seam: the implementation works on erased contracts/handlers/
  // derivers; the public builder type re-attaches the generics. The typed
  // methods' arguments are structurally assignable to the erased
  // parameters, so the only unsafe step is this widening of the return
  // type — same seam as the DOT app builder's makeBuilder.
  return impl as unknown as RouteBundleBuilder;
}

/** Start an empty bundle. See the module docs for the authoring pattern. */
export function routes(): RouteBundleBuilder {
  return makeBuilder({ derivers: [], bindings: [], mounts: [] });
}
