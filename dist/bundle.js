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
import { BASE_CTX_KEYS } from './derive.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
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
    return impl;
}
/** Start an empty bundle. See the module docs for the authoring pattern. */
export function routes() {
    return makeBuilder({ derivers: [], bindings: [], mounts: [] });
}
//# sourceMappingURL=bundle.js.map