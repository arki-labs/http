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
import { describeInternalError, HTTP_ERROR_CODES } from './error.js';

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  // Disable proxy buffering (nginx and friends) — events must flush.
  'x-accel-buffering': 'no',
} as const;

export function sseResponse(iterable: AsyncIterable<unknown>, contract: ContractLike, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const iterator = iterable[Symbol.asyncIterator]();
  let heartbeat: NodeJS.Timeout | undefined;
  let finished = false;

  const cleanup = (): void => {
    finished = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
  };

  const stopIterator = async (): Promise<void> => {
    try {
      await iterator.return?.();
    } catch {
      // Generator cleanup failures have no caller to surface to here; the
      // generator's own resources are the pip's responsibility.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      if (contract.heartbeatMs !== undefined && contract.heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          if (!finished && (controller.desiredSize ?? 0) > 0) {
            controller.enqueue(encoder.encode(':keepalive\n\n'));
          }
        }, contract.heartbeatMs);
        heartbeat.unref();
      }
      signal.addEventListener(
        'abort',
        () => {
          cleanup();
          void stopIterator();
        },
        { once: true },
      );
    },
    async pull(controller): Promise<void> {
      try {
        const next = await iterator.next();
        if (finished) return;
        if (next.done === true) {
          cleanup();
          controller.close();
          return;
        }
        const value = contract.event === undefined ? next.value : contract.event.parse(next.value);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      } catch (error) {
        if (finished) return;
        cleanup();
        const payload = {
          error: {
            code: HTTP_ERROR_CODES.internal,
            message: describeInternalError(error),
          },
        };
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
        controller.close();
        void stopIterator();
      }
    },
    cancel(): void {
      cleanup();
      void stopIterator();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
