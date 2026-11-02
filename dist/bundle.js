import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import { HTTP_ACTION_META_SCHEMA } from './openapi.js';
export const REPLY = Symbol.for('@arki/http/reply');
/**
 * Answer with one of the contract's `responses`: `reply(404, { reason })`.
 * The status must be a key of `responses` and the body must fit its schema.
 * Extra `headers` ride along on the response.
 */
export function reply(status, body, init = {}) {
    return { [REPLY]: true, status, body, ...(init.headers === undefined ? {} : { headers: init.headers }) };
}
export function isReply(value) {
    return typeof value === 'object' && value !== null && REPLY in value;
}
export function rpcMount(path, options) {
    assertMountPath(path, options.id);
    const transport = options.transport ?? 'orpc';
    return {
        ...options,
        kind: 'rpc-mount',
        id: options.id,
        path,
        transport,
        ...(options.summary === undefined ? {} : { summary: options.summary }),
        toDotAction() {
            return {
                id: options.id,
                binding: transport,
                direction: 'in',
                address: path,
                ...(options.summary === undefined ? {} : { summary: options.summary }),
                metaSchema: HTTP_ACTION_META_SCHEMA,
                meta: { path, rpc: true },
            };
        },
    };
}
function assertMountPath(path, id) {
    if (!path.startsWith('/') || path.includes(' ')) {
        throw new HttpConfigError({
            code: HTTP_ERROR_CODES.invalidMount,
            message: `[http] mount path "${path}" for "${id}" is invalid — it must start with "/" and contain no spaces.`,
            remediation: 'Mount under an absolute path prefix, e.g. "/rpc".',
        });
    }
}
function makeBuilder(state) {
    const impl = {
        stages: state.stages,
        bindings: state.bindings,
        mounts: state.mounts,
        rpcs: state.rpcs,
        use(stage) {
            return makeBuilder({ ...state, stages: [...state.stages, stage] });
        },
        bind(contract, handler, options = {}) {
            return makeBuilder({
                ...state,
                bindings: [...state.bindings, { contract, handler, stages: state.stages, ...options }],
            });
        },
        mount(path, handler, meta) {
            assertMountPath(path, meta.id);
            return makeBuilder({
                ...state,
                mounts: [...state.mounts, { id: meta.id, path, transport: meta.transport ?? 'custom', handler }],
            });
        },
        rpc(contract, handlers) {
            return makeBuilder({
                ...state,
                rpcs: [
                    ...state.rpcs,
                    {
                        contract,
                        stages: state.stages,
                        id: contract.id,
                        path: contract.path,
                        transport: contract.transport,
                        context: handlers.context,
                        handle: handlers.handle,
                    },
                ],
            });
        },
    };
    // Public overloads retain inferred contracts, context and failure sets;
    // this implementation stores erased callbacks without altering their values.
    return impl;
}
/** Start an empty bundle. See the module docs for the authoring pattern. */
export function routes() {
    return makeBuilder({ stages: [], bindings: [], mounts: [], rpcs: [] });
}
//# sourceMappingURL=bundle.js.map