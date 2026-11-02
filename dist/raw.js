/**
 * `raw()` — the explicit marker for a route whose handler owns the whole
 * response. Kept in its own module so the contract checks, the engine and
 * OpenAPI can all read it without importing each other.
 */
export const RAW_OUTPUT = Symbol.for('@arki/http/raw-output');
/**
 * Declare `output: raw()` when the handler returns a `Response` it built —
 * a redirect, a file, a stream, or a handler that owns its own error
 * formats. The engine passes the `Response` through and never validates
 * it. `contentType` only feeds OpenAPI. `responses` may still document the
 * payload; the engine ignores it in raw mode.
 */
export function raw(options = {}) {
    return { [RAW_OUTPUT]: true, ...(options.contentType === undefined ? {} : { contentType: options.contentType }) };
}
export function isRawOutput(value) {
    return typeof value === 'object' && value !== null && RAW_OUTPUT in value;
}
//# sourceMappingURL=raw.js.map