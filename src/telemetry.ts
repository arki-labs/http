import type { Span } from '@opentelemetry/api';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';

import { UnexpectedDefect } from '@arki/failure';

import { HttpError } from './error.js';

/** Reporting has no authority over the request or its response. */
function observe(report: () => void): void {
  try {
    report();
  } catch {
    /* Application-owned instrumentation is best effort. */
  }
}

/** One request/cache operation; a defective context manager cannot repeat its work. */
export function observeHttp(name: string, run: () => Response | Promise<Response>): Promise<Response> {
  let span: Span | undefined;
  observe(() => {
    span = trace.getTracer('@arki/http').startSpan(name);
  });
  // Nothing records this span (no provider, or the sampler dropped it):
  // there is no context to propagate and no attribute anyone will read.
  // End it now and run directly: no async frame, no microtask, no context switch.
  if (span === undefined || !span.isRecording()) {
    observe(() => {
      span?.end();
    });
    try {
      const outcome = run();
      return outcome instanceof Promise ? outcome : Promise.resolve(outcome);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return observeRecording(span, run);
}

/** The recording path: the span wraps the execution and reports its outcome. */
async function observeRecording(span: Span, run: () => Response | Promise<Response>): Promise<Response> {
  let execution: Promise<Response> | undefined;
  // Reserve ownership before any handler/provider/reporter can reenter the callback.
  const execute = () => (execution ??= Promise.resolve().then(run));
  observe(() => {
    if (span !== undefined) {
      void Promise.resolve(context.with(trace.setSpan(context.active(), span), execute)).catch(() => {
        // Observe asynchronous reporter failures; the owned execution supplies the response.
      });
    }
  });
  try {
    const response = await execute();
    observe(() => {
      span?.setAttribute('http.response.status_code', response.status);
    });
    if (response.status >= 500)
      observe(() => {
        span?.setStatus({ code: SpanStatusCode.ERROR });
      });
    return response;
  } catch (error) {
    observe(() => {
      span?.setAttribute('failure.code', error instanceof HttpError ? error.code : UnexpectedDefect.code);
    });
    observe(() => {
      span?.setStatus({ code: SpanStatusCode.ERROR });
    });
    throw error;
  } finally {
    observe(() => {
      span?.end();
    });
  }
}
