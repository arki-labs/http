import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { isFailure, isFault, UnexpectedDefect } from '@arki/failure';
function report(action) {
    try {
        void Promise.resolve(action()).catch(() => {
            /* Rejected reporters are best effort. */
        });
    }
    catch {
        /* Instrumentation cannot alter webhook execution. */
    }
}
/** Own execution before entering application instrumentation, including reentrant context managers. */
export async function observeWebhook(name, run) {
    let span;
    report(() => {
        span = trace.getTracer('@arki/http').startSpan(name);
        return span;
    });
    let execution;
    const execute = () => (execution ??= Promise.resolve().then(run));
    report(() => (span === undefined ? undefined : context.with(trace.setSpan(context.active(), span), execute)));
    try {
        const value = await execute();
        if (isFailure(value)) {
            report(() => {
                return span?.setAttribute('failure.code', value.code);
            });
            // An expected outcome (4xx) leaves the status unset; only a fault (5xx) is an error.
            if (isFault(value))
                report(() => {
                    return span?.setStatus({ code: SpanStatusCode.ERROR });
                });
        }
        return value;
    }
    catch (error) {
        report(() => {
            return span?.setAttribute('failure.code', UnexpectedDefect.code);
        });
        report(() => {
            return span?.setStatus({ code: SpanStatusCode.ERROR });
        });
        return UnexpectedDefect({ cause: error });
    }
    finally {
        report(() => {
            return span?.end();
        });
    }
}
//# sourceMappingURL=webhook-telemetry.js.map