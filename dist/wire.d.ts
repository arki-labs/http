/**
 * Wire forms — how a contract names the schemas that read and write HTTP.
 *
 * A bare Standard Schema means the wire form is the value form: the server
 * decodes with it and encodes with it. {@link codec} pairs two schemas when
 * the forms differ (an ISO string on the wire, a `Date` in code).
 * {@link optional} marks a header, query key or optional path placeholder
 * the request may leave out; the marker, not the schema, decides `?:`.
 */
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import type { RawOutput } from './raw.js';
type MaybePromise<T> = T | Promise<T>;
/** Wire <-> value. `decode` reads what arrives; `encode` writes what leaves. Create with {@link codec}. */
export type Codec = {
    readonly decode: StandardSchemaV1;
    readonly encode: StandardSchemaV1;
};
/**
 * `unknown` when `decode`'s output feeds `encode` and `encode`'s output feeds
 * `decode`; `never` (a compile error at {@link codec}) when the pair does not
 * reverse.
 */
export type Reversible<TDecode extends StandardSchemaV1, TEncode extends StandardSchemaV1> = [
    SchemaOutput<TDecode>
] extends [SchemaInput<TEncode>] ? [SchemaOutput<TEncode>] extends [SchemaInput<TDecode>] ? unknown : never : never;
/**
 * A two-way field: `decode` turns the wire form into the value the handler
 * sees, `encode` turns that value back. The pair must reverse each other's
 * types, or the call fails to compile.
 *
 * @example
 * const isoDate = codec(
 *   z.iso.datetime().transform(text => new Date(text)),
 *   z.date().transform(date => date.toISOString()),
 * );
 */
export declare function codec<TDecode extends StandardSchemaV1, TEncode extends StandardSchemaV1>(decode: TDecode, encode: TEncode & NoInfer<Reversible<TDecode, TEncode>>): {
    readonly decode: TDecode;
    readonly encode: TEncode;
};
/** A bare schema (wire form = value form) or a {@link Codec}. */
export type Wire = StandardSchemaV1 | Codec;
/** A header, query key or optional path placeholder the request may leave out. Create with {@link optional}. */
export type Optional<TWire extends Wire = Wire> = {
    readonly schema: TWire;
    readonly optional: true;
};
/**
 * Mark a field the request may leave out. A missing key reaches the handler
 * as `undefined`, without running the schema; a present one runs it.
 *
 * @example
 * query: { page: optional(z.coerce.number().int()) }
 */
export declare function optional<TWire extends Wire>(schema: TWire): Optional<TWire>;
/** One params, headers or query entry. */
export type Field = Wire | Optional;
/** Params, headers or query: one field per key. */
export type Fields = Readonly<Record<string, Field>>;
/** The schema that reads the wire: the codec's `decode`, or the bare schema. */
type DecoderOf<TWire> = TWire extends StandardSchemaV1 ? TWire : TWire extends Codec ? TWire['decode'] : never;
/** The value form of a wire: what the handler receives and the client resolves to. */
export type WireValue<TWire extends Wire> = SchemaOutput<DecoderOf<TWire>>;
/** The value of one field; an {@link optional} one may be `undefined`. */
export type ValueOf<TField extends Field> = TField extends Optional<infer TWire> ? WireValue<TWire> | undefined : TField extends Wire ? WireValue<TField> : never;
/** Merge an intersection into one object type, so editors show it plainly. */
type Flatten<T> = {
    [K in keyof T]: T[K];
};
/** The handler's and the client's view of a field record: the {@link optional} marker decides `?:`. */
export type FieldsOf<TFields extends Fields> = Flatten<{
    readonly [K in keyof TFields as TFields[K] extends Optional ? never : K]: ValueOf<TFields[K]>;
} & {
    readonly [K in keyof TFields as TFields[K] extends Optional ? K : never]?: ValueOf<TFields[K]>;
}>;
/** The schema that reads `wire` (decode direction), with its fast path (see {@link compiledOf}). */
export declare function decoderOf(wire: Wire): StandardSchemaV1;
/** The schema that writes `wire` (encode direction), with its fast path. A bare schema is its own encoder. */
export declare function encoderOf(wire: Wire): StandardSchemaV1;
/** A field's wire and whether the request may leave it out. */
export declare function fieldParts(field: Field): {
    readonly wire: Wire;
    readonly optional: boolean;
};
/** True when `value` is a bare schema, a {@link codec} pair or an {@link optional} marker. */
export declare function isField(value: unknown): value is Field;
/** True when `value` is a bare schema or a {@link codec} pair. */
export declare function isWire(value: unknown): value is Wire;
/** True when an `output` declares a body schema (not `raw()`, not absent). */
export declare function isOutputWire(output: Wire | RawOutput | undefined): output is Wire;
/** Where a request value lives, as the first segment of its issue paths. */
export type Where = 'params' | 'headers' | 'query' | 'body';
/** One schema run: the schema, the value, and the path its issues get (`['query', 'page']`). */
export type Job = {
    readonly at: readonly [Where] | readonly [Where, string];
    readonly schema: StandardSchemaV1;
    readonly value: unknown;
};
/** Stands in for the schema of a required field the request left out: always one issue. */
export declare const missingField: StandardSchemaV1;
/** A finished {@link Job}. */
export type Ran = {
    readonly job: Job;
    readonly result: StandardSchemaV1.Result<unknown>;
};
/**
 * Run one schema. Synchronous when the schema answers synchronously, so a
 * route whose schemas are all sync never waits a microtask. A throw or a
 * rejection is an explicit `UnexpectedFailure` carrying `ValidatorDefect`, never issues: it answers 500.
 */
export declare function runSchema(schema: StandardSchemaV1, value: unknown): MaybePromise<StandardSchemaV1.Result<unknown>>;
/**
 * Run every job, in order. Synchronous when every schema answers synchronously.
 * Async schemas run side by side; the first failure in job order wins, and a
 * later one never goes unhandled.
 */
export declare function runJobs(jobs: readonly Job[]): MaybePromise<readonly Ran[]>;
/** Every issue of the runs, its path prefixed with where the value came from. */
export declare function issuesOf(runs: readonly Ran[]): StandardSchemaV1.Issue[];
export {};
//# sourceMappingURL=wire.d.ts.map