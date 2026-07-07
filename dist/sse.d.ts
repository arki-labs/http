/**
 * Server-sent-events serialization for {@link SseContract} bindings.
 *
 * The bound handler is an async iterable; every yielded value is validated
 * against the contract's event schema and framed as `data: <json>\n\n`.
 * Client disconnect terminates the iterator (its `finally` blocks run);
 * a yielded value that violates the schema — or a generator crash — emits
 * a terminal `event: error` frame with the coded envelope, then closes.
 */
import type { ContractLike } from './contract.js';
export declare function sseResponse(iterable: AsyncIterable<unknown>, contract: ContractLike, signal: AbortSignal): Response;
//# sourceMappingURL=sse.d.ts.map