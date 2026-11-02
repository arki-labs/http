/**
 * Route contracts — the static half of an HTTP surface.
 *
 * A contract is pure data at module scope: method + path + Standard Schemas +
 * a stable id. No handler, no services, no I/O. That split is what makes
 * three things possible at once:
 *
 *  - `configure` can register it in the DOT manifest (configure is sync);
 *  - OpenAPI generation is static — no boot required;
 *  - the handler signature is fully inferred when the contract is bound
 *    (see `routes().bind()` in `bundle.ts`).
 */
import type { Failure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import type { RouteMeta } from './openapi.js';
import type { RawOutput } from './raw.js';
import type { Field, Fields, FieldsOf, Wire, WireValue } from './wire.js';
/** Methods a {@link RouteContract} can declare. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** Placeholder names as written: `'/a/:id/:slug?'` → `'id' | 'slug?'`. */
type RawParams<TPath extends string> = TPath extends `${string}:${infer Rest}` ? Rest extends `${infer Param}/${infer Tail}` ? Param | RawParams<`/${Tail}`> : Rest : never;
/**
 * Path-parameter names extracted from a path literal at the type level:
 * `'/orders/:id/items/:itemId'` → `'id' | 'itemId'`. An optional
 * placeholder (`:itemId?`) counts under its plain name.
 */
export type PathParams<TPath extends string> = RawParams<TPath> extends infer P extends string ? (P extends `${infer Name}?` ? Name : P) : never;
type OptionalParams<TPath extends string> = RawParams<TPath> extends infer P extends string ? (P extends `${infer Name}?` ? Name : never) : never;
/** Typed view of a path's parameters: every value is a string, an optional one may be missing. */
export type ParamsOf<TPath extends string> = Readonly<Record<Exclude<PathParams<TPath>, OptionalParams<TPath>>, string> & Partial<Record<OptionalParams<TPath>, string>>>;
/**
 * A failure definition as a contract lists it: what `defineFailure` returns.
 * The client revives a listed failure with it (code + data schema); the
 * failure value itself carries the status and message the server answers with.
 */
export type FailureDefinitionLike = {
    readonly code: string;
    readonly dataSchema: StandardSchemaV1 | undefined;
    (...args: never[]): Failure;
};
/** The failure values a contract lists: `RouteFailure<typeof getPost>`. */
export type RouteFailure<TContract> = TContract extends {
    readonly failures: infer TFailures extends readonly FailureDefinitionLike[];
} ? ReturnType<TFailures[number]> : never;
/** Reject every possible contract that omits any owned failure, including widened unions. */
type IncompleteFailureContract<Contract, Outcomes> = Contract extends unknown ? [Outcomes] extends [RouteFailure<Contract>] ? never : Contract : never;
export type CoversFailures<Contract, Outcomes> = [IncompleteFailureContract<Contract, Outcomes>] extends [never] ? unknown : never;
/**
 * Status code to body schema, for the statuses a handler may answer with
 * `reply(status, body)`. Integer keys 200-599. Never 204 or 304 (they carry
 * no body: a route without `output` answers 204), and never 200 next to a
 * schema `output`. On a `raw()` route the schemas only document.
 */
export type ResponseSchemas = Readonly<Record<number, Wire>>;
/** What a cross-field `check` returns: the problems it found, or nothing. Any issue answers 400. */
export type CheckResult = readonly StandardSchemaV1.Issue[] | undefined;
/**
 * The decoded inputs a bound handler receives (and a `check` reads). A def
 * without `params` gives the raw path strings; without `query`, `headers`
 * or `body`, `undefined`.
 */
export type RouteInput<TPath extends string, TDef> = {
    readonly params: TDef extends {
        readonly params: infer TFields extends Fields;
    } ? FieldsOf<TFields> : ParamsOf<TPath>;
    readonly query: TDef extends {
        readonly query: infer TFields extends Fields;
    } ? FieldsOf<TFields> : undefined;
    readonly headers: TDef extends {
        readonly headers: infer TFields extends Fields;
    } ? FieldsOf<TFields> : undefined;
    readonly body: TDef extends {
        readonly body: infer TWire extends Wire;
    } ? WireValue<TWire> : undefined;
};
/**
 * The parts `check` reads, as separate type parameters of the factory: a
 * `check` arrow sits in the same object literal as the fields it reads, and
 * TypeScript types its parameter from type parameters inferred off the
 * earlier properties, not from the def as a whole.
 */
type CheckOf<TPath extends string, TParams extends Fields | undefined, TQuery extends Fields | undefined, THeaders extends Fields | undefined, TBody extends Wire | undefined> = {
    readonly params?: TParams;
    readonly query?: TQuery;
    readonly headers?: THeaders;
    readonly body?: TBody;
    readonly check?: (input: RouteInput<TPath, {
        readonly params: TParams;
        readonly query: TQuery;
        readonly headers: THeaders;
        readonly body: TBody;
    }>) => CheckResult;
};
/** What a JSON route declares. The generic `TDef` of {@link RouteContract} is the literal def. */
export type RouteDef<TPath extends string> = {
    /** Stable identifier — lands in the manifest and OpenAPI `operationId`. */
    readonly id: string;
    readonly summary?: string;
    /** One field per path placeholder. An optional placeholder (`:x?`) takes an `optional(...)` field. */
    readonly params?: Readonly<Record<PathParams<TPath>, Field>>;
    /** One field per header the route reads. Keys are lower-case. */
    readonly headers?: Fields;
    /** One field per query key the route reads. */
    readonly query?: Fields;
    readonly body?: Wire;
    /**
     * The success body. A schema: the handler returns its value, sent as
     * 200 JSON. `raw()`: the handler returns a `Response`. Absent: the handler
     * returns nothing and the route answers 204. Keys the schema does not
     * declare are sent unless the schema drops them (zod and valibot objects
     * do; an arktype object needs `'+': 'delete'`).
     */
    readonly output?: Wire | RawOutput;
    readonly responses?: ResponseSchemas;
    /**
     * The failures the handler may return, as `defineFailure` definitions. A
     * returned failure answers with its status and the error envelope; the
     * client resolves to it instead of throwing.
     */
    readonly failures?: readonly FailureDefinitionLike[];
    /**
     * Cross-field check, after every field and the body decoded. Issues answer
     * 400 as `where.key: message`: give them paths like `['query', 'to']`.
     */
    readonly check?: (input: never) => CheckResult;
};
/**
 * A JSON route contract. Create via {@link route}. `TDef` is the literal
 * def, so the bound handler's input and result types, and the client's, are
 * read straight from the declared schemas.
 */
export type RouteContract<TPath extends string = string, TDef extends RouteDef<TPath> = RouteDef<TPath>> = TDef & {
    readonly kind: 'http';
    readonly method: HttpMethod;
    readonly path: TPath;
    toDotAction(): RouteMeta;
};
/** What a typed SSE route declares. */
export type SseDef<TPath extends string> = Pick<RouteDef<TPath>, 'id' | 'summary' | 'params' | 'query' | 'headers' | 'check' | 'failures'> & {
    /** Schema every yielded event is encoded with. */
    readonly event: Wire;
    /** Emit `:keepalive` comments at this interval. Off when omitted. */
    readonly heartbeatMs?: number;
};
/**
 * A typed server-sent-events contract. Create via {@link route.sse}. The
 * bound handler is an async generator; every yielded value is validated
 * against `event` and framed as an SSE `data:` message.
 */
export type SseContract<TPath extends string = string, TDef extends SseDef<TPath> = SseDef<TPath>> = TDef & {
    readonly kind: 'sse';
    readonly method: 'GET';
    readonly path: TPath;
    toDotAction(): RouteMeta;
};
/** The decoded request a generics-erased `check` reads. */
export type ErasedInput = {
    readonly params: unknown;
    readonly query: unknown;
    readonly headers: unknown;
    readonly body: unknown;
};
/**
 * Generics-erased view of a contract — what bundles store and the engine,
 * manifest registration, and OpenAPI generation consume. Both contract
 * types are structurally assignable to it; no casts involved. `check` is a
 * method so a contract's typed check (which reads its own decoded request)
 * still fits.
 */
export type ContractLike = {
    readonly kind: 'http' | 'sse';
    readonly id: string;
    readonly method: HttpMethod;
    readonly path: string;
    readonly summary?: string;
    readonly params?: Fields;
    readonly query?: Fields;
    readonly headers?: Fields;
    readonly body?: Wire;
    readonly output?: Wire | RawOutput;
    readonly responses?: ResponseSchemas;
    readonly failures?: readonly FailureDefinitionLike[];
    readonly event?: Wire;
    readonly heartbeatMs?: number;
    check?(input: ErasedInput): CheckResult;
    toDotAction(): RouteMeta;
};
/**
 * Contract factories, one per method, plus {@link route.sse} for typed
 * event streams.
 *
 * ```ts
 * export const listOrders = route.get('/orders', {
 *   id: 'orders.list',
 *   query: { status: optional(z.enum(['open', 'shipped'])) },
 *   output: z.array(Order),
 * });
 *
 * export const getOrder = route.get('/orders/:id', {
 *   id: 'orders.get',
 *   params: { id: OrderId },
 *   headers: { 'x-tenant': z.string() },
 *   output: Order,
 *   responses: { 409: Conflict }, // handler: return reply(409, { ... })
 *   failures: [OrderNotFound], // defineFailure definitions the handler may return
 * });
 *
 * export const progress = route.sse('/orders/:id/progress', {
 *   id: 'orders.progress',
 *   event: z.discriminatedUnion('type', [Queued, Shipped]),
 * });
 * ```
 */
export declare const route: {
    get: <TPath extends string, TDef extends RouteDef<TPath>, TParams extends Fields | undefined = undefined, TQuery extends Fields | undefined = undefined, THeaders extends Fields | undefined = undefined, TBody extends Wire | undefined = undefined>(path: TPath, def: TDef & CheckOf<TPath, TParams, TQuery, THeaders, TBody>) => RouteContract<TPath, TDef>;
    post: <TPath extends string, TDef extends RouteDef<TPath>, TParams extends Fields | undefined = undefined, TQuery extends Fields | undefined = undefined, THeaders extends Fields | undefined = undefined, TBody extends Wire | undefined = undefined>(path: TPath, def: TDef & CheckOf<TPath, TParams, TQuery, THeaders, TBody>) => RouteContract<TPath, TDef>;
    put: <TPath extends string, TDef extends RouteDef<TPath>, TParams extends Fields | undefined = undefined, TQuery extends Fields | undefined = undefined, THeaders extends Fields | undefined = undefined, TBody extends Wire | undefined = undefined>(path: TPath, def: TDef & CheckOf<TPath, TParams, TQuery, THeaders, TBody>) => RouteContract<TPath, TDef>;
    patch: <TPath extends string, TDef extends RouteDef<TPath>, TParams extends Fields | undefined = undefined, TQuery extends Fields | undefined = undefined, THeaders extends Fields | undefined = undefined, TBody extends Wire | undefined = undefined>(path: TPath, def: TDef & CheckOf<TPath, TParams, TQuery, THeaders, TBody>) => RouteContract<TPath, TDef>;
    delete: <TPath extends string, TDef extends RouteDef<TPath>, TParams extends Fields | undefined = undefined, TQuery extends Fields | undefined = undefined, THeaders extends Fields | undefined = undefined, TBody extends Wire | undefined = undefined>(path: TPath, def: TDef & CheckOf<TPath, TParams, TQuery, THeaders, TBody>) => RouteContract<TPath, TDef>;
    sse: <TPath extends string, TDef extends SseDef<TPath>, TParams extends Fields | undefined = undefined, TQuery extends Fields | undefined = undefined, THeaders extends Fields | undefined = undefined>(path: TPath, def: TDef & CheckOf<TPath, TParams, TQuery, THeaders, undefined>) => SseContract<TPath, TDef>;
};
export {};
//# sourceMappingURL=contract.d.ts.map