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
import { isStandardSchema } from '@arki/schema';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import { contractMeta } from './openapi.js';
import { pathPlaceholders } from './path.js';
import { isRawOutput } from './raw.js';
import { fieldParts, isField, isWire } from './wire.js';
function invalid(id, problem, remediation) {
    throw new HttpConfigError({
        code: HTTP_ERROR_CODES.invalidContract,
        message: `[http] route "${id}" is invalid: ${problem}`,
        remediation,
    });
}
/**
 * Declaration-time checks. A contract that cannot work fails here, with the
 * contract id and the bad key, instead of on the first request.
 */
function assertContract(path, def) {
    const placeholders = pathPlaceholders(path);
    const optional = placeholders.filter(placeholder => placeholder.optional);
    if (optional.length > 1 || (optional[0] !== undefined && !path.endsWith(`:${optional[0].name}?`))) {
        invalid(def.id, `path "${path}" has an optional placeholder that is not the only, last segment.`, 'The router supports one optional placeholder, as the last segment: "/orders/:id?".');
    }
    if (def.params !== undefined) {
        const params = fieldsOf(def.id, 'params', def.params);
        const names = new Set(placeholders.map(placeholder => placeholder.name));
        for (const name of names) {
            if (!(name in params)) {
                invalid(def.id, `params has no key for the placeholder ":${name}".`, `Add "${name}" to params.`);
            }
        }
        for (const [key, field] of Object.entries(params)) {
            if (!names.has(key)) {
                invalid(def.id, `params key "${key}" is not a placeholder of "${path}".`, 'Remove the key, or add the placeholder to the path.');
            }
            const placeholderOptional = optional.some(placeholder => placeholder.name === key);
            const fieldOptional = fieldParts(field).optional;
            if (placeholderOptional && !fieldOptional) {
                invalid(def.id, `params key "${key}" is optional in the path (":${key}?") but its field is required.`, `Wrap the field: ${key}: optional(schema).`);
            }
            if (fieldOptional && !placeholderOptional) {
                invalid(def.id, `params key "${key}" is optional(...) but the path placeholder ":${key}" is required.`, `Write the placeholder as ":${key}?", or drop optional(...).`);
            }
        }
    }
    if (def.headers !== undefined) {
        for (const key of Object.keys(fieldsOf(def.id, 'headers', def.headers))) {
            if (key !== key.toLowerCase()) {
                invalid(def.id, `header key "${key}" is not lower-case.`, `Use "${key.toLowerCase()}": the Fetch API lower-cases every header name.`);
            }
        }
    }
    if (def.query !== undefined)
        fieldsOf(def.id, 'query', def.query);
    if (def.body !== undefined)
        wireOf(def.id, 'body', def.body);
    if (def.event !== undefined)
        wireOf(def.id, 'event', def.event);
    if (def.output !== undefined && !isRawOutput(def.output))
        wireOf(def.id, 'output', def.output);
    if (def.responses !== undefined && typeof def.responses === 'object' && def.responses !== null) {
        const responses = Object.entries(def.responses);
        for (const [key, schema] of responses) {
            const status = Number(key);
            if (!Number.isInteger(status) || status < 200 || status > 599) {
                invalid(def.id, `responses key "${key}" is not a status from 200 to 599.`, 'Use integer status codes.');
            }
            if (status === 204 || status === 304) {
                invalid(def.id, `responses cannot declare ${status}: it has no body.`, status === 204
                    ? 'Leave out "output" and return nothing to answer 204.'
                    : 'Return a Response from a route declared with output: raw().');
            }
            if (status === 200 && def.output !== undefined && !isRawOutput(def.output)) {
                invalid(def.id, 'responses declares 200 next to output.', 'Declare the 200 body once, as "output".');
            }
            wireOf(def.id, `responses.${key}`, schema);
        }
    }
}
const FIELD_REMEDIATION = 'Give each key a schema, codec(decode, encode) or optional(schema).';
/** `value` as a record of fields; throws naming the bad key. A whole schema is the common mistake. */
function fieldsOf(id, where, value) {
    if (isStandardSchema(value) || typeof value !== 'object' || value === null) {
        invalid(id, `${where} must be a record of fields, not one schema.`, `Declare ${where} as { key: schema }. ${FIELD_REMEDIATION}`);
    }
    const fields = {};
    const entries = Object.entries(value);
    for (const [key, field] of entries) {
        if (!isField(field))
            invalid(id, `${where}.${key} is not a schema.`, FIELD_REMEDIATION);
        fields[key] = field;
    }
    return fields;
}
/** `value` as a wire; throws naming where it sits. */
function wireOf(id, where, value) {
    if (!isWire(value)) {
        invalid(id, `${where} is not a schema.`, 'Use a Standard Schema (zod, valibot, arktype, …) or codec(decode, encode).');
    }
    return value;
}
const makeRoute = (method) => (path, def) => {
    assertContract(path, def);
    const contract = {
        ...def,
        kind: 'http',
        method,
        path,
        toDotAction: () => contractMeta(contract),
    };
    return contract;
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
export const route = {
    get: makeRoute('GET'),
    post: makeRoute('POST'),
    put: makeRoute('PUT'),
    patch: makeRoute('PATCH'),
    delete: makeRoute('DELETE'),
    sse: (path, def) => {
        assertContract(path, def);
        const contract = {
            ...def,
            kind: 'sse',
            method: 'GET',
            path,
            toDotAction: () => contractMeta(contract),
        };
        return contract;
    },
};
//# sourceMappingURL=contract.js.map