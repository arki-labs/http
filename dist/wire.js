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
import { UnexpectedFailure, ValidatorDefect } from '@arki/failure';
import { isStandardSchema, pathOf } from '@arki/schema';
import { isRawOutput } from './raw.js';
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
export function codec(decode, encode) {
    return { decode, encode };
}
/**
 * Mark a field the request may leave out. A missing key reaches the handler
 * as `undefined`, without running the schema; a present one runs it.
 *
 * @example
 * query: { page: optional(z.coerce.number().int()) }
 */
export function optional(schema) {
    return { schema, optional: true };
}
/**
 * The schema with its generated fast path, built once per schema. A zod
 * schema becomes its `z.compile()` clone (same results, same issues, a
 * generated parser instead of the interpreter; zod falls back to the
 * interpreter for a schema it cannot model). Any other Standard Schema is
 * used as is. Keyed by identity, so a schema shared by many routes compiles
 * once.
 */
const compiled = new WeakMap();
function compiledOf(schema) {
    let fast = compiled.get(schema);
    if (fast === undefined) {
        fast = schema instanceof z.ZodType ? z.compile(schema) : schema;
        compiled.set(schema, fast);
    }
    return fast;
}
/** The schema that reads `wire` (decode direction), with its fast path (see {@link compiledOf}). */
export function decoderOf(wire) {
    return compiledOf(isStandardSchema(wire) ? wire : wire.decode);
}
/** The schema that writes `wire` (encode direction), with its fast path. A bare schema is its own encoder. */
export function encoderOf(wire) {
    return compiledOf(isStandardSchema(wire) ? wire : wire.encode);
}
/** A field's wire and whether the request may leave it out. */
export function fieldParts(field) {
    if (isStandardSchema(field) || !('optional' in field))
        return { wire: field, optional: false };
    return { wire: field.schema, optional: true };
}
/** True when `value` is a bare schema, a {@link codec} pair or an {@link optional} marker. */
export function isField(value) {
    if (isStandardSchema(value))
        return true;
    if (typeof value !== 'object' || value === null)
        return false;
    if ('optional' in value && 'schema' in value)
        return value.optional === true && isWire(value.schema);
    return isWire(value);
}
/** True when `value` is a bare schema or a {@link codec} pair. */
export function isWire(value) {
    if (isStandardSchema(value))
        return true;
    return (typeof value === 'object' &&
        value !== null &&
        'decode' in value &&
        'encode' in value &&
        isStandardSchema(value.decode) &&
        isStandardSchema(value.encode));
}
/** True when an `output` declares a body schema (not `raw()`, not absent). */
export function isOutputWire(output) {
    return output !== undefined && !isRawOutput(output);
}
/** Stands in for the schema of a required field the request left out: always one issue. */
export const missingField = {
    '~standard': {
        version: 1,
        vendor: 'arki-http',
        validate: () => ({ issues: [{ message: 'is required' }] }),
    },
};
function threw(error) {
    return new UnexpectedFailure(ValidatorDefect({ cause: error }));
}
/**
 * Run one schema. Synchronous when the schema answers synchronously, so a
 * route whose schemas are all sync never waits a microtask. A throw or a
 * rejection is an explicit `UnexpectedFailure` carrying `ValidatorDefect`, never issues: it answers 500.
 */
export function runSchema(schema, value) {
    const standard = schema['~standard'];
    let result;
    try {
        result = standard.validate(value);
    }
    catch (error) {
        throw threw(error);
    }
    if (isThenable(result)) {
        return Promise.resolve(result).catch((error) => {
            throw threw(error);
        });
    }
    return result;
}
/** An async result. A sync result may carry a `then` field that is not a function; that is still sync. */
function isThenable(result) {
    return 'then' in result && typeof result.then === 'function';
}
/** Marks a rejection as handled; the first failure in job order is the one that is thrown. */
function ignoreRejection() {
    return undefined;
}
/**
 * Run every job, in order. Synchronous when every schema answers synchronously.
 * Async schemas run side by side; the first failure in job order wins, and a
 * later one never goes unhandled.
 */
export function runJobs(jobs) {
    const pending = [];
    try {
        for (const job of jobs) {
            const result = runSchema(job.schema, job.value);
            pending.push(result instanceof Promise ? result.then(settled => ({ job, result: settled })) : { job, result });
        }
    }
    catch (error) {
        // A schema threw synchronously: the ones already started must not reject unhandled.
        for (const run of pending)
            if (run instanceof Promise)
                run.then(undefined, ignoreRejection);
        throw error;
    }
    if (!pending.some(run => run instanceof Promise))
        return pending.filter(run => isRan(run));
    return settleAll(pending);
}
function isRan(run) {
    return !(run instanceof Promise);
}
/** Wait for every run, in job order. Every promise is handled up front, so only the awaited one can throw. */
async function settleAll(pending) {
    for (const run of pending)
        if (run instanceof Promise)
            run.then(undefined, ignoreRejection);
    const runs = [];
    for (const run of pending)
        runs.push(await run);
    return runs;
}
/** Every issue of the runs, its path prefixed with where the value came from. */
export function issuesOf(runs) {
    const issues = [];
    for (const { job, result } of runs) {
        for (const issue of result.issues ?? [])
            issues.push({ message: issue.message, path: [...job.at, ...pathOf(issue)] });
    }
    return issues;
}
//# sourceMappingURL=wire.js.map