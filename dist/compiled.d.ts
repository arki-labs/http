/**
 * The compiled engine — the default `buildEngine`.
 *
 * Each route whose path is static segments and `:name` segments is matched
 * by this file's own router: a `Map` for static paths, a segment trie for
 * the rest, built once. Everything the trie does not serve goes to the Hono
 * engine behind it: mounts, rpc mounts, routes under a mount prefix,
 * optional placeholders (`:x?`), wildcards, regex placeholders, and the 404.
 * Both engines run the same per-route pipeline (`executeBinding`), so a
 * route answers the same whichever one matched it.
 *
 * On Bun the matched routes are also offered as a `Bun.serve` `routes`
 * table (`Engine.bunRoutes`), so the socket layer matches them natively.
 *
 * Priority: a route this router serves answers before any overlapping
 * Hono-only pattern, whatever the declaration order. Routes under a mount
 * prefix are left to Hono for that reason.
 */
import type { RouteBundle } from './bundle.js';
import type { Engine, EngineOptions } from './engine.js';
/**
 * Build the default engine: this router for the routes it can serve, the
 * Hono engine for the rest, one fetch in front of both. Duplicate routes
 * fail here, across both engines, with the same error as before.
 */
export declare function buildEngine(bundles: readonly RouteBundle[], options?: EngineOptions): Engine;
//# sourceMappingURL=compiled.d.ts.map