/**
 * Wire forms — how a contract names the schemas that read and write HTTP.
 *
 * A bare Standard Schema means the wire form is the value form: the server
 * decodes with it and encodes with it. {@link codec} pairs two schemas when
 * the forms differ (an ISO string on the wire, a `Date` in code).
 * {@link optional} marks a header, query key or optional path placeholder
 * the request may leave out; the marker, not the schema, decides `?:`.
 */

import { z } from 'zod';

import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { UnexpectedFailure, ValidatorDefect } from '@arki/failure';
import { isStandardSchema, pathOf } from '@arki/schema';

import type { RawOutput } from './raw.js';
import { isRawOutput } from './raw.js';

type MaybePromise<T> = T | Promise<T>;

/** Wire <-> value. `decode` reads what arrives; `encode` writes what leaves. Create with {@link codec}. */
export type Codec = { readonly decode: StandardSchemaV1; readonly encode: StandardSchemaV1 };

/**
 * `unknown` when `decode`'s output feeds `encode` and `encode`'s output feeds
 * `decode`; `never` (a compile error at {@link codec}) when the pair does not
 * reverse.
 */
export type Reversible<TDecode extends StandardSchemaV1, TEncode extends StandardSchemaV1> = [
  SchemaOutput<TDecode>,
] extends [SchemaInput<TEncode>]
  ? [SchemaOutput<TEncode>] extends [SchemaInput<TDecode>]
    ? unknown
    : never
  : never;

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
export function codec<TDecode extends StandardSchemaV1, TEncode extends StandardSchemaV1>(
  decode: TDecode,
  encode: TEncode & NoInfer<Reversible<TDecode, TEncode>>,
): { readonly decode: TDecode; readonly encode: TEncode } {
  return { decode, encode };
}

/** A bare schema (wire form = value form) or a {@link Codec}. */
export type Wire = StandardSchemaV1 | Codec;

/** A header, query key or optional path placeholder the request may leave out. Create with {@link optional}. */
export type Optional<TWire extends Wire = Wire> = { readonly schema: TWire; readonly optional: true };

/**
 * Mark a field the request may leave out. A missing key reaches the handler
 * as `undefined`, without running the schema; a present one runs it.
 *
 * @example
 * query: { page: optional(z.coerce.number().int()) }
 */
export function optional<TWire extends Wire>(schema: TWire): Optional<TWire> {
  return { schema, optional: true };
}

/** One params, headers or query entry. */
export type Field = Wire | Optional;

/** Params, headers or query: one field per key. */
export type Fields = Readonly<Record<string, Field>>;

/** The schema that reads the wire: the codec's `decode`, or the bare schema. */
type DecoderOf<TWire> = TWire extends StandardSchemaV1 ? TWire : TWire extends Codec ? TWire['decode'] : never;

/** The value form of a wire: what the handler receives and the client resolves to. */
export type WireValue<TWire extends Wire> = SchemaOutput<DecoderOf<TWire>>;

/** The value of one field; an {@link optional} one may be `undefined`. */
export type ValueOf<TField extends Field> =
  TField extends Optional<infer TWire> ? WireValue<TWire> | undefined : TField extends Wire ? WireValue<TField> : never;

/** Merge an intersection into one object type, so editors show it plainly. */
type Flatten<T> = { [K in keyof T]: T[K] };

/** The handler's and the client's view of a field record: the {@link optional} marker decides `?:`. */
export type FieldsOf<TFields extends Fields> = Flatten<
  { readonly [K in keyof TFields as TFields[K] extends Optional ? never : K]: ValueOf<TFields[K]> } & {
    readonly [K in keyof TFields as TFields[K] extends Optional ? K : never]?: ValueOf<TFields[K]>;
  }
>;

/**
 * The schema with its generated fast path, built once per schema. A zod
 * schema becomes its `z.compile()` clone (same results, same issues, a
 * generated parser instead of the interpreter; zod falls back to the
 * interpreter for a schema it cannot model). Any other Standard Schema is
 * used as is. Keyed by identity, so a schema shared by many routes compiles
 * once.
 */
const compiled = new WeakMap<StandardSchemaV1, StandardSchemaV1>();
function compiledOf(schema: StandardSchemaV1): StandardSchemaV1 {
  let fast = compiled.get(schema);
  if (fast === undefined) {
    fast = schema instanceof z.ZodType ? z.compile(schema) : schema;
    compiled.set(schema, fast);
  }
  return fast;
}

/** The schema that reads `wire` (decode direction), with its fast path (see {@link compiledOf}). */
export function decoderOf(wire: Wire): StandardSchemaV1 {
  return compiledOf(isStandardSchema(wire) ? wire : wire.decode);
}

/** The schema that writes `wire` (encode direction), with its fast path. A bare schema is its own encoder. */
export function encoderOf(wire: Wire): StandardSchemaV1 {
  return compiledOf(isStandardSchema(wire) ? wire : wire.encode);
}

/** A field's wire and whether the request may leave it out. */
export function fieldParts(field: Field): { readonly wire: Wire; readonly optional: boolean } {
  if (isStandardSchema(field) || !('optional' in field)) return { wire: field, optional: false };
  return { wire: field.schema, optional: true };
}

/** True when `value` is a bare schema, a {@link codec} pair or an {@link optional} marker. */
export function isField(value: unknown): value is Field {
  if (isStandardSchema(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  if ('optional' in value && 'schema' in value) return value.optional === true && isWire(value.schema);
  return isWire(value);
}

/** True when `value` is a bare schema or a {@link codec} pair. */
export function isWire(value: unknown): value is Wire {
  if (isStandardSchema(value)) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    'decode' in value &&
    'encode' in value &&
    isStandardSchema(value.decode) &&
    isStandardSchema(value.encode)
  );
}

/** True when an `output` declares a body schema (not `raw()`, not absent). */
export function isOutputWire(output: Wire | RawOutput | undefined): output is Wire {
  return output !== undefined && !isRawOutput(output);
}

/** Where a request value lives, as the first segment of its issue paths. */
export type Where = 'params' | 'headers' | 'query' | 'body';

/** One schema run: the schema, the value, and the path its issues get (`['query', 'page']`). */
export type Job = {
  readonly at: readonly [Where] | readonly [Where, string];
  readonly schema: StandardSchemaV1;
  readonly value: unknown;
};

/** Stands in for the schema of a required field the request left out: always one issue. */
export const missingField: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'arki-http',
    validate: () => ({ issues: [{ message: 'is required' }] }),
  },
};

/** A finished {@link Job}. */
export type Ran = { readonly job: Job; readonly result: StandardSchemaV1.Result<unknown> };

function threw(error: unknown) {
  return new UnexpectedFailure(ValidatorDefect({ cause: error }));
}

/**
 * Run one schema. Synchronous when the schema answers synchronously, so a
 * route whose schemas are all sync never waits a microtask. A throw or a
 * rejection is an explicit `UnexpectedFailure` carrying `ValidatorDefect`, never issues: it answers 500.
 */
export function runSchema(schema: StandardSchemaV1, value: unknown): MaybePromise<StandardSchemaV1.Result<unknown>> {
  const standard = schema['~standard'];
  let result: MaybePromise<StandardSchemaV1.Result<unknown>>;
  try {
    result = standard.validate(value);
  } catch (error) {
    throw threw(error);
  }
  if (isThenable(result)) {
    return Promise.resolve(result).catch((error: unknown) => {
      throw threw(error);
    });
  }
  return result;
}

/** An async result. A sync result may carry a `then` field that is not a function; that is still sync. */
function isThenable<T extends object>(result: T | PromiseLike<T>): result is PromiseLike<T> {
  return 'then' in result && typeof result.then === 'function';
}

/** Marks a rejection as handled; the first failure in job order is the one that is thrown. */
function ignoreRejection(): void {
  return undefined;
}

/**
 * Run every job, in order. Synchronous when every schema answers synchronously.
 * Async schemas run side by side; the first failure in job order wins, and a
 * later one never goes unhandled.
 */
export function runJobs(jobs: readonly Job[]): MaybePromise<readonly Ran[]> {
  const pending: MaybePromise<Ran>[] = [];
  try {
    for (const job of jobs) {
      const result = runSchema(job.schema, job.value);
      pending.push(result instanceof Promise ? result.then(settled => ({ job, result: settled })) : { job, result });
    }
  } catch (error) {
    // A schema threw synchronously: the ones already started must not reject unhandled.
    for (const run of pending) if (run instanceof Promise) run.then(undefined, ignoreRejection);
    throw error;
  }
  if (!pending.some(run => run instanceof Promise)) return pending.filter(run => isRan(run));
  return settleAll(pending);
}

function isRan(run: MaybePromise<Ran>): run is Ran {
  return !(run instanceof Promise);
}

/** Wait for every run, in job order. Every promise is handled up front, so only the awaited one can throw. */
async function settleAll(pending: readonly MaybePromise<Ran>[]): Promise<readonly Ran[]> {
  for (const run of pending) if (run instanceof Promise) run.then(undefined, ignoreRejection);
  const runs: Ran[] = [];
  for (const run of pending) runs.push(await run);
  return runs;
}

/** Every issue of the runs, its path prefixed with where the value came from. */
export function issuesOf(runs: readonly Ran[]): StandardSchemaV1.Issue[] {
  const issues: StandardSchemaV1.Issue[] = [];
  for (const { job, result } of runs) {
    for (const issue of result.issues ?? [])
      issues.push({ message: issue.message, path: [...job.at, ...pathOf(issue)] });
  }
  return issues;
}
