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
type JsonObject = Record<string, unknown>;
/**
 * Render an OpenAPI 3.1 document from contracts. Paths and operations
 * appear in contract order; duplicate method+path pairs fail loudly with
 * `ARKI_HTTP_E002` (the same collision `buildEngine` rejects at boot).
 */
export declare function toOpenApi(contracts: readonly ContractLike[], info: OpenApiInfo): JsonObject;
/** The DOT `registerRoute` argument derived from a contract. */
export type RouteMeta = {
    readonly id: string;
    readonly method: string;
    readonly path: string;
    readonly transport: 'http';
    readonly description?: string;
    readonly input?: {
        readonly query?: JsonObject;
        readonly body?: JsonObject;
    };
    readonly output?: JsonObject;
    readonly streaming?: boolean;
};
/**
 * Manifest metadata for a contract — what `registerRoutes` (from
 * `@arki/http/dot`) feeds into `ctx.registerRoute` so that
 * `dot explain --openapi` can render without booting. SSE contracts mark
 * `streaming` and carry the per-event schema as `output`.
 */
export declare function contractMeta(contract: ContractLike): RouteMeta;
export {};
//# sourceMappingURL=openapi.d.ts.map