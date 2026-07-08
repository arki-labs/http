/**
 * Route bundles — the dynamic half of an HTTP surface.
 *
 * A bundle binds contracts to handlers. It is assembled inside a plugin's
 * `boot` hook — where the plugin's `needs` are already injected — so handlers
 * and derivers close over typed singletons:
 *
 * ```ts
 * export const OrdersRoutes = token<RouteBundle>()('orders.routes');
 *
 * export const ordersPlugin = plugin({
 *   name: 'orders',
 *   needs: { db: service<Db>() },
 *   actions: [listOrders, createOrder],
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
import { HTTP_ACTION_META_SCHEMA } from './openapi.js';
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
export type RouteHandler<TPath extends string, TQuery, TBody, TOutput, TCtx extends BaseRequestCtx> = (input: RouteInput<TPath, TQuery, TBody>, ctx: TCtx) => MaybePromise<HandlerResult<TOutput>>;
/**
 * Handler signature inferred from an {@link SseContract}: an async
 * iterable (usually an async generator) of events. Each yielded value is
 * validated against the contract's event schema and framed as an SSE
 * `data:` message. Client disconnect aborts `ctx.signal` and terminates
 * the iterator.
 */
export type SseHandler<TPath extends string, TQuery, TEvent, TCtx extends BaseRequestCtx> = (input: RouteInput<TPath, TQuery, undefined>, ctx: TCtx) => AsyncIterable<TEvent>;
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
/** Manifest declaration an {@link RpcMountDef} produces via `toDotAction()`. */
export type RpcActionMeta = {
    readonly id: string;
    readonly binding: MountTransport;
    readonly direction: 'in';
    readonly address: string;
    readonly summary?: string;
    readonly metaSchema: typeof HTTP_ACTION_META_SCHEMA;
    readonly meta: {
        readonly path: string;
        readonly rpc: true;
    };
};
/**
 * The STATIC half of an RPC mount — pure data plus `toDotAction()`, so a
 * feature plugin lists it in `actions:` at module level (declare-once), and
 * binds `context`/`handle` in `boot` where its services exist
 * (bind-once) — the exact contract/handler split `route.get(...)` uses.
 */
export type RpcMountContract = {
    readonly kind: 'rpc-mount';
    /** Stable manifest id, e.g. 'orders.rpc'. */
    readonly id: string;
    /** Path prefix the RPC handler owns, e.g. '/rpc/orders'. */
    readonly path: string;
    readonly transport: MountTransport;
    readonly summary?: string;
    toDotAction(): RpcActionMeta;
};
export type RpcMountOptions = {
    readonly id: string;
    /** Manifest binding name. Defaults to `'orpc'`. */
    readonly transport?: MountTransport;
    readonly summary?: string;
};
/**
 * The boot-time half: a per-request context factory (receives the
 * bundle's accumulated derived ctx, typed) and the dispatch — typically
 * an oRPC `RPCHandler` or tRPC fetch adapter built once at boot.
 */
export type RpcMountHandlers<TDerived extends BaseRequestCtx, TRpcCtx> = {
    readonly context: (req: Request, ctx: TDerived) => TRpcCtx | Promise<TRpcCtx>;
    readonly handle: (req: Request, ctx: NoInfer<TRpcCtx>) => Response | Promise<Response>;
};
/** Erased rpc binding a bundle stores — same seam as {@link RouteBinding}. */
export type RpcBinding = {
    readonly id: string;
    readonly path: string;
    readonly transport: MountTransport;
    readonly context: (req: Request, ctx: never) => unknown;
    readonly handle: (req: Request, ctx: never) => Response | Promise<Response>;
};
/** Declare the static half of an RPC mount. See {@link RpcMountContract}. */
export declare function rpcMount(path: string, options: RpcMountOptions): RpcMountContract;
/**
 * A plain value: derivers + bound contracts + mounts. Published as an
 * ordinary DOT service under a token and collected by the `http()` plugin —
 * no new kernel concept.
 */
export type RouteBundle = {
    readonly derivers: readonly ErasedDeriver[];
    readonly bindings: readonly RouteBinding[];
    readonly mounts: readonly MountBinding[];
    /** Typed RPC mounts — optional so hand-rolled bundles stay valid. */
    readonly rpcs?: readonly RpcBinding[];
};
/**
 * Immutable bundle builder. Every method returns a new builder; deriver
 * keys accumulate in `TCtx` so later `bind` handlers see them typed.
 */
export type RouteBundleBuilder<TCtx extends BaseRequestCtx = BaseRequestCtx> = RouteBundle & {
    /** Add a reusable deriver (see {@link Deriver}). */
    derive<K extends string, V>(deriver: Deriver<K, V, TCtx>): RouteBundleBuilder<TCtx & Readonly<Record<K, V>>>;
    /** Add an inline deriver. */
    derive<K extends string, V>(key: K, fn: (req: Request, ctx: TCtx) => V | Promise<V>): RouteBundleBuilder<TCtx & Readonly<Record<K, V>>>;
    /**
     * Bind a JSON contract to its handler. `NoInfer` pins the input/output
     * generics to the contract — without it, a handler returning the wrong
     * shape would silently widen `TOutput` instead of failing to compile.
     */
    bind<TPath extends string, TQuery, TBody, TOutput>(contract: RouteContract<TPath, TQuery, TBody, TOutput>, handler: RouteHandler<TPath, NoInfer<TQuery>, NoInfer<TBody>, NoInfer<TOutput>, TCtx>): RouteBundleBuilder<TCtx>;
    /** Bind an SSE contract to its event generator. */
    bind<TPath extends string, TQuery, TEvent>(contract: SseContract<TPath, TQuery, TEvent>, handler: SseHandler<TPath, NoInfer<TQuery>, NoInfer<TEvent>, TCtx>): RouteBundleBuilder<TCtx>;
    /**
     * Mount a foreign fetch handler under a path prefix — an oRPC router, a
     * tRPC fetch adapter, a static-file handler. One manifest route, no
     * schemas, derivers do NOT run for mounted handlers.
     */
    mount(path: string, handler: (req: Request) => Response | Promise<Response>, meta: MountMeta): RouteBundleBuilder<TCtx>;
    /**
     * Bind a static {@link RpcMountContract} to its boot-time handlers.
     * Unlike `mount`, the bundle's derivers RUN before dispatch, and the
     * context factory receives the accumulated derived ctx — derivers
     * added before `.rpc()` are typed into it.
     */
    rpc<TRpcCtx>(contract: RpcMountContract, handlers: RpcMountHandlers<TCtx, TRpcCtx>): RouteBundleBuilder<TCtx>;
};
/** Start an empty bundle. See the module docs for the authoring pattern. */
export declare function routes(): RouteBundleBuilder;
/** The `@arki/feature` slice contract an `endpoints(...)` declaration produces. */
export type EndpointsFeatureSlice<TServices> = {
    readonly key: 'routes';
    readonly actions: readonly never[];
    readonly resolve: (services: TServices) => RouteBundle;
};
/**
 * Declare a feature's HTTP surface as a boot-time slice
 * (`defineFeature(..., { use: [endpoints(build)] })`). The builder runs
 * once at boot with the feature's needed services; the bundle lands
 * under `routes` in the feature's slice token — where
 * `http({ features })` collects it. Route contracts stay in the
 * feature's `actions` list.
 */
export declare function endpoints<TServices>(build: (services: TServices) => RouteBundle): EndpointsFeatureSlice<TServices>;
export {};
//# sourceMappingURL=bundle.d.ts.map