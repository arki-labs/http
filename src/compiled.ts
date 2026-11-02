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

import type { RouteBinding, RouteBundle } from './bundle.js';
import type { BunRequestLike, Engine, EngineOptions } from './engine.js';
import { buildHonoApp, claimRoute, executeBinding, requestScopeOf } from './engine.js';
import { observeHttp } from './telemetry.js';

type Params = Readonly<Record<string, string>>;
type Run = (req: Request, params: Params) => Response | Promise<Response>;
type TrieNode = {
  readonly children: Map<string, TrieNode>;
  param?: TrieNode;
  /** Set on a terminal node: the route and the names of its `:param` segments, in path order. */
  route?: { readonly run: Run; readonly paramNames: readonly string[] };
};
type MethodTable = { readonly exact: Map<string, Run>; readonly root: TrieNode };

const NO_PARAMS: Params = Object.freeze({});
const trieNode = (): TrieNode => ({ children: new Map() });

/** True when every segment is static or exactly `:name`. */
function compilablePath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  for (const segment of path.slice(1).split('/')) {
    if (/^:\w+$/.test(segment)) continue;
    if (/[:*?{}]/.test(segment)) return false;
  }
  return true;
}

/** True when `path` is `prefix` or lies under it. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/**
 * `/a/b` from `http://host/a/b?q=1`; no `URL` object. Percent-encoding is
 * decoded the way Hono's `getPath` does it: `decodeURI` over the path, with
 * `%25` kept as `%25` so a param segment's own `decodeURIComponent` is the
 * only decode of what the client encoded (`%2541` → `%41`, never `A`).
 */
function pathOf(url: string): string {
  const scheme = url.indexOf('//');
  const start = url.indexOf('/', scheme === -1 ? 0 : scheme + 2);
  if (start === -1) return '/';
  const query = url.indexOf('?', start);
  const hash = url.indexOf('#', start);
  const end = query === -1 ? (hash === -1 ? url.length : hash) : hash === -1 ? query : Math.min(query, hash);
  const path = url.slice(start, end);
  if (!path.includes('%')) return path;
  return tryDecode(path.includes('%25') ? path.replaceAll('%25', '%2525') : path, decodeURI);
}

/** Decode, or keep the text when it is not valid percent-encoding (as Hono does). */
function tryDecode(text: string, decode: (text: string) => string): string {
  try {
    return decode(text);
  } catch {
    return text;
  }
}

function insert(table: MethodTable, path: string, run: Run): void {
  if (!path.includes(':')) {
    table.exact.set(path, run);
    return;
  }
  let node = table.root;
  const paramNames: string[] = [];
  for (const segment of path.slice(1).split('/')) {
    if (segment.startsWith(':')) {
      // The trie keys the position; each route keeps its own names.
      paramNames.push(segment.slice(1));
      node = node.param ??= trieNode();
    } else {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = trieNode();
        node.children.set(segment, child);
      }
      node = child;
    }
  }
  node.route = { run, paramNames };
}

type Hit = { readonly run: Run; readonly params: Params };

/**
 * Walk the trie over the path's segments from `from` (just after a `/`),
 * static child first, then the param child, backtracking when the static
 * branch dead-ends. Param values collect in `values`; the object is built
 * once, at the terminal node.
 */
function walk(node: TrieNode, path: string, from: number, values: string[]): Hit | undefined {
  if (from > path.length) {
    if (node.route === undefined) return undefined;
    if (values.length === 0) return { run: node.route.run, params: NO_PARAMS };
    const params: Record<string, string> = {};
    node.route.paramNames.forEach((name, index) => {
      params[name] = values[index] ?? '';
    });
    return { run: node.route.run, params };
  }
  let end = path.indexOf('/', from);
  if (end === -1) end = path.length;
  const segment = path.slice(from, end);
  const child = node.children.get(segment);
  if (child !== undefined) {
    const hit = walk(child, path, end + 1, values);
    if (hit !== undefined) return hit;
  }
  if (node.param === undefined) return undefined;
  values.push(segment.includes('%') ? tryDecode(segment, decodeURIComponent) : segment);
  const hit = walk(node.param, path, end + 1, values);
  if (hit === undefined) values.pop();
  return hit;
}

function match(table: MethodTable, path: string): Hit | undefined {
  const exact = table.exact.get(path);
  if (exact !== undefined) return { run: exact, params: NO_PARAMS };
  if (table.root.children.size === 0 && table.root.param === undefined) return undefined;
  return walk(table.root, path, 1, []);
}

/**
 * Build the default engine: this router for the routes it can serve, the
 * Hono engine for the rest, one fetch in front of both. Duplicate routes
 * fail here, across both engines, with the same error as before.
 */
export function buildEngine(bundles: readonly RouteBundle[], options?: EngineOptions): Engine {
  const scope = requestScopeOf(options);
  const claimed = new Map<string, string>();
  const prefixes = bundles.flatMap(bundle => [
    ...bundle.mounts.map(mount => mount.path),
    ...(bundle.rpcs ?? []).map(rpc => rpc.path),
  ]);
  const tables = new Map<string, MethodTable>();
  const bunRoutes: Record<string, Record<string, (req: BunRequestLike) => Response | Promise<Response>>> = {};
  const routeIds: string[] = [];
  const honoBundles: RouteBundle[] = [];

  for (const bundle of bundles) {
    for (const mount of bundle.mounts) routeIds.push(mount.id);
    for (const rpc of bundle.rpcs ?? []) routeIds.push(rpc.id);
    const honoBindings: RouteBinding[] = [];
    for (const binding of bundle.bindings) {
      const { contract } = binding;
      claimRoute(claimed, contract);
      routeIds.push(contract.id);
      if (!compilablePath(contract.path) || prefixes.some(prefix => underPrefix(contract.path, prefix))) {
        honoBindings.push(binding);
        continue;
      }
      let table = tables.get(contract.method);
      if (table === undefined) {
        table = { exact: new Map(), root: trieNode() };
        tables.set(contract.method, table);
      }
      const run: Run = (req, params) => executeBinding(bundle, binding, req, params, scope);
      insert(table, contract.path, run);
      // Bun matched the route: run it under the same request span as `fetch`.
      // A layer that forwarded a different Request has no params; route it here.
      (bunRoutes[contract.path] ??= {})[contract.method] = req =>
        observeHttp('http.request', () => ('params' in req ? run(req, req.params) : dispatch(req)));
    }
    honoBundles.push({ ...bundle, bindings: honoBindings });
  }

  const hono = buildHonoApp(honoBundles, options);
  const dispatch = (req: Request): Response | Promise<Response> => {
    const table = tables.get(req.method);
    if (table !== undefined) {
      const hit = match(table, pathOf(req.url));
      if (hit !== undefined) return hit.run(req, hit.params);
    }
    return hono.fetch(req);
  };

  const engine: Engine = {
    fetch: req => observeHttp('http.request', () => dispatch(req)),
    routeIds,
    ...(Object.keys(bunRoutes).length === 0 ? {} : { bunRoutes }),
  };
  return engine;
}
