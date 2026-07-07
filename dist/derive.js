/**
 * Request-scope derivers — "scope is data, not containers."
 *
 * A deriver is a named function from `(req, ctx)` to a value; each one
 * adds a typed key to the per-request context handlers receive. Derivers
 * run in declaration order, later derivers see earlier keys typed, and a
 * deriver that throws {@link HttpError} short-circuits into the wire
 * envelope — which is the entire "guard" story:
 *
 * ```ts
 * const withPrincipal = derive('principal', async req => {
 *   const p = await auth.verify(req.headers.get('authorization'));
 *   if (!p) throw new HttpError(401, HTTP_ERROR_CODES.unauthorized, 'missing or invalid credentials');
 *   return p;
 * });
 * ```
 *
 * Because bundles are assembled inside a pip's `boot`, derivers close over
 * injected singletons — request scope is function application over the
 * compile-time-wired service graph, not per-request container resolution.
 */
/** Base context keys — derivers may not shadow these. */
export const BASE_CTX_KEYS = ['req', 'url', 'requestId', 'signal'];
/** Create a reusable {@link Deriver}. */
export function derive(key, fn) {
    return { key, derive: fn };
}
//# sourceMappingURL=derive.js.map