/**
 * Path placeholders — one reading of `:id` and `:id?` for the contract
 * checks, the engine's route claims, and OpenAPI. Internal: not exported
 * from the package.
 */
export type Placeholder = {
    readonly name: string;
    readonly optional: boolean;
};
/** `/orders/:id/items/:itemId?` → `[{ id }, { itemId, optional }]`, in path order. */
export declare function pathPlaceholders(path: string): readonly Placeholder[];
/**
 * The concrete OpenAPI paths a route path serves. `/a/:x` is `/a/{x}`.
 * `/a/:x?` is two paths: `/a/{x}` and `/a` (`omitted: 'x'`), because
 * OpenAPI has no optional path parameter.
 */
export declare function openApiPaths(path: string): readonly {
    readonly path: string;
    readonly omitted?: string;
}[];
//# sourceMappingURL=path.d.ts.map