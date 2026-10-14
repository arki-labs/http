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
import { BASE_CTX_KEYS } from './derive.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import { HTTP_ACTION_META_SCHEMA } from './openapi.js';
/** Declare the static half of an RPC mount. See {@link RpcMountContract}. */
export function rpcMount(path, options) {
    assertMountPath(path, options.id);
    const transport = options.transport ?? 'orpc';
    return {
        kind: 'rpc-mount',
        id: options.id,
        path,
        transport,
        ...(options.summary === undefined ? {} : { summary: options.summary }),
        toDotAction() {
            return {
                id: options.id,
                binding: transport,
                direction: 'in',
                address: path,
                ...(options.summary === undefined ? {} : { summary: options.summary }),
                metaSchema: HTTP_ACTION_META_SCHEMA,
                meta: { path, rpc: true },
            };
        },
    };
}
function assertMountPath(path, id) {
    if (!path.startsWith('/') || path.includes(' ')) {
        throw new HttpConfigError({
            code: HTTP_ERROR_CODES.invalidMount,
            message: `[http] mount path "${path}" for "${id}" is invalid — it must start with "/" and contain no spaces.`,
            remediation: 'Mount under an absolute path prefix, e.g. "/rpc".',
        });
    }
}
function assertFreshDeriverKey(key, existing) {
    const reserved = BASE_CTX_KEYS.includes(key);
    const duplicate = existing.some(d => d.key === key);
    if (!reserved && !duplicate)
        return;
    throw new HttpConfigError({
        code: HTTP_ERROR_CODES.duplicateDeriverKey,
        message: reserved
            ? `[http] deriver key "${key}" shadows a base request-context key.`
            : `[http] deriver key "${key}" is already derived in this bundle.`,
        remediation: `Pick a different key — base keys (${BASE_CTX_KEYS.join(', ')}) and earlier deriver keys are reserved.`,
    });
}
function makeBuilder(state) {
    const impl = {
        derivers: state.derivers,
        bindings: state.bindings,
        mounts: state.mounts,
        rpcs: state.rpcs,
        derive(keyOrDeriver, fn) {
            let deriver;
            if (typeof keyOrDeriver === 'string') {
                if (fn === undefined) {
                    throw new HttpConfigError({
                        code: HTTP_ERROR_CODES.duplicateDeriverKey,
                        message: `[http] derive("${keyOrDeriver}") is missing its deriver function.`,
                        remediation: 'Pass derive(key, fn) or derive(deriverObject).',
                    });
                }
                deriver = { key: keyOrDeriver, derive: fn };
            }
            else {
                deriver = keyOrDeriver;
            }
            assertFreshDeriverKey(deriver.key, state.derivers);
            return makeBuilder({ ...state, derivers: [...state.derivers, deriver] });
        },
        bind(contract, handler) {
            return makeBuilder({ ...state, bindings: [...state.bindings, { contract, handler }] });
        },
        mount(path, handler, meta) {
            assertMountPath(path, meta.id);
            return makeBuilder({
                ...state,
                mounts: [...state.mounts, { id: meta.id, path, transport: meta.transport ?? 'custom', handler }],
            });
        },
        rpc(contract, handlers) {
            return makeBuilder({
                ...state,
                rpcs: [
                    ...state.rpcs,
                    {
                        id: contract.id,
                        path: contract.path,
                        transport: contract.transport,
                        context: handlers.context,
                        handle: handlers.handle,
                    },
                ],
            });
        },
    };
    // Erasure seam: the implementation works on erased contracts/handlers/
    // derivers; the public builder type re-attaches the generics. The typed
    // methods' arguments are structurally assignable to the erased
    // parameters, so the only unsafe step is this widening of the return
    // type — same seam as the DOT app builder's makeBuilder.
    return impl;
}
/** Start an empty bundle. See the module docs for the authoring pattern. */
export function routes() {
    return makeBuilder({ derivers: [], bindings: [], mounts: [], rpcs: [] });
}
/**
 * Declare a feature's HTTP surface as a boot-time slice
 * (`feature(..., { use: [endpoints(build)] })`). The builder runs
 * once at boot with the feature's needed services; the bundle lands
 * under `routes` in the feature's slice record — where the
 * `.serve(http(...))` driver collects it. Route contracts stay in the
 * feature's `actions` list.
 */
export function endpoints(build) {
    return { key: 'routes', actions: [], resolve: build };
}
//# sourceMappingURL=bundle.js.map