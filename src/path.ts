/**
 * Path placeholders — one reading of `:id` and `:id?` for the contract
 * checks, the engine's route claims, and OpenAPI. Internal: not exported
 * from the package.
 */

export type Placeholder = { readonly name: string; readonly optional: boolean };

/** `/orders/:id/items/:itemId?` → `[{ id }, { itemId, optional }]`, in path order. */
export function pathPlaceholders(path: string): readonly Placeholder[] {
  const found: Placeholder[] = [];
  for (const match of path.matchAll(/:(\w+)(\?)?/g)) {
    const name = match[1];
    if (name !== undefined) found.push({ name, optional: match[2] === '?' });
  }
  return found;
}

/**
 * The concrete OpenAPI paths a route path serves. `/a/:x` is `/a/{x}`.
 * `/a/:x?` is two paths: `/a/{x}` and `/a` (`omitted: 'x'`), because
 * OpenAPI has no optional path parameter.
 */
export function openApiPaths(path: string): readonly { readonly path: string; readonly omitted?: string }[] {
  const full = path.replaceAll(/:(\w+)\??/g, '{$1}');
  const optional = pathPlaceholders(path).find(placeholder => placeholder.optional);
  if (optional === undefined) return [{ path: full }];
  const base = path.replace(new RegExp(`/:${optional.name}\\?$`), '') || '/';
  return [{ path: full }, { path: base, omitted: optional.name }];
}
