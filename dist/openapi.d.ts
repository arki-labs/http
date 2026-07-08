/**
 * OpenAPI generation — falls out of the contracts, doesn't bolt on.
 *
 * Contracts are static data carrying zod schemas, so the document is
 * produced without booting anything, deterministically: same contracts in
 * the same order → byte-identical output (DOT principle 3). No decorator
 * reconstruction, no annotations — the schema IS the validation IS the
 * documentation.
 */
import type { ContractLike } from './contract.js';
export type OpenApiInfo = {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
};
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
export declare const HTTP_ACTION_META_SCHEMA = "@arki/http/action-meta@1";
/**
 * Render an OpenAPI 3.1 document from contracts. Paths and operations
 * appear in contract order; duplicate method+path pairs fail loudly with
 * `ARKI_HTTP_E002` (the same collision `buildEngine` rejects at boot).
 */
export declare function toOpenApi(contracts: readonly ContractLike[], info: OpenApiInfo): JsonObject;
type DotActionLike = {
    readonly id: string;
    readonly plugin: string;
    readonly binding: string;
    readonly direction: 'in' | 'out';
    readonly address?: string;
    readonly summary?: string;
    readonly meta?: JsonObject;
    readonly metaSchema?: string;
};
type DotManifestLike = {
    readonly app: {
        readonly name: string;
        readonly version?: string;
    };
    readonly actions: readonly DotActionLike[];
};
/** The DOT action declaration derived from a contract. */
export type RouteMeta = {
    readonly id: string;
    readonly binding: 'http';
    readonly direction: 'in';
    readonly address: string;
    readonly summary?: string;
    readonly metaSchema: typeof HTTP_ACTION_META_SCHEMA;
    readonly meta: JsonObject;
};
/**
 * Manifest metadata for a contract — what contract `toDotAction()` returns
 * for DOT plugins and what `registerRoutes` feeds into `ctx.registerAction`
 * during the shim window. SSE contracts mark `streaming` and carry the
 * per-event schema as `output`.
 */
export declare function contractMeta(contract: ContractLike): RouteMeta;
export declare function toOpenApiFromManifest(manifest: DotManifestLike): JsonObject;
export {};
//# sourceMappingURL=openapi.d.ts.map