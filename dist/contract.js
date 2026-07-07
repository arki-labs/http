/**
 * Route contracts — the static half of an HTTP surface.
 *
 * A contract is pure data at module scope: method + path + zod schemas +
 * a stable id. No handler, no services, no I/O. That split is what makes
 * three things possible at once:
 *
 *  - `configure` can register it in the DOT manifest (configure is sync);
 *  - OpenAPI generation is static — no boot required;
 *  - the handler signature is fully inferred when the contract is bound
 *    (see `routes().bind()` in `bundle.ts`).
 */
const makeRoute = (method) => (path, def) => ({
    kind: 'http',
    method,
    path,
    ...def,
});
/**
 * Contract factories, one per method, plus {@link route.sse} for typed
 * event streams.
 *
 * ```ts
 * export const listOrders = route.get('/orders', {
 *   id: 'orders.list',
 *   query: z.object({ status: z.enum(['open', 'shipped']).optional() }),
 *   output: z.array(Order),
 * });
 *
 * export const progress = route.sse('/orders/:id/progress', {
 *   id: 'orders.progress',
 *   event: z.discriminatedUnion('type', [Queued, Shipped]),
 * });
 * ```
 */
export const route = {
    get: makeRoute('GET'),
    post: makeRoute('POST'),
    put: makeRoute('PUT'),
    patch: makeRoute('PATCH'),
    delete: makeRoute('DELETE'),
    sse: (path, def) => ({
        kind: 'sse',
        method: 'GET',
        path,
        ...def,
    }),
};
//# sourceMappingURL=contract.js.map