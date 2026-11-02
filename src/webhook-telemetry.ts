import type { Span } from '@opentelemetry/api';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';

import { isFailure, UnexpectedDefect } from '@arki/failure';

function report(action: () => unknown): void {
  try {
    void Promise.resolve(action()).catch(() => {
      /* Rejected reporters are best effort. */
    });
  } catch {
    /* Instrumentation cannot alter webhook execution. */
  }
}

/** Own execution before entering application instrumentation, including reentrant context managers. */
export async function observeWebhook<Value>(
  name: string,
  run: () => Value | Promise<Value>,
): Promise<Value | ReturnType<typeof UnexpectedDefect>> {
  let span: Span | undefined;
  report(() => {
    span = trace.getTracer('@arki/http').startSpan(name);
    return span;
  });
  let execution: Promise<Value> | undefined;
  const execute = () => (execution ??= Promise.resolve().then(run));
  report(() => (span === undefined ? undefined : context.with(trace.setSpan(context.active(), span), execute)));
  try {
    const value = await execute();
    if (isFailure<unknown>(value)) {
      report(() => {
        return span?.setAttribute('failure.code', value.code);
      });
      report(() => {
        return span?.setStatus({ code: SpanStatusCode.ERROR });
      });
    }
    return value;
  } catch (error) {
    report(() => {
      return span?.setAttribute('failure.code', UnexpectedDefect.code);
    });
    report(() => {
      return span?.setStatus({ code: SpanStatusCode.ERROR });
    });
    return UnexpectedDefect({ cause: error });
  } finally {
    report(() => {
      return span?.end();
    });
  }
}
