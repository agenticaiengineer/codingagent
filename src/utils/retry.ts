/**
 * Shared retry utilities used by both the main agentic loop (loop.ts)
 * and compaction (compaction.ts). Previously each module contained its
 * own copy of these helpers — HTTP status detection, non-retryable error
 * classification, exponential backoff with jitter, abort-aware sleep,
 * and error reason extraction — risking silent divergence when one copy
 * was updated but not the other.
 */
import { hasErrnoCode, safeTruncate } from "../tools/validate.js";

// ── Constants ──

const JITTER_FACTOR = 0.25;

// ── Type guards ──

/**
 * Type guard: checks whether an unknown value has a numeric `status` property
 * (e.g., Anthropic SDK HTTP errors).  Narrows the type so callers can access
 * `.status` without redundant `as` casts.
 */
export function hasHttpStatus(err: unknown): err is { status: number } {
  return (
    err != null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

/**
 * Returns true if the error is an HTTP error with a status code
 * in the 4xx range (excluding 408 and 429), which should NOT be retried.
 *
 * 429 (Too Many Requests) is retryable because it's a transient rate limit.
 * 408 (Request Timeout) is retryable because it's typically returned by
 * reverse proxies (nginx, Cloudflare, API gateways) when the upstream
 * server takes too long to respond — a transient condition that may
 * succeed on retry. The Anthropic API itself doesn't return 408, but
 * proxied setups commonly do for long-running streaming responses.
 *
 * Also detects non-retryable errors from proxies/gateways that embed the
 * HTTP status in the error *message* string (e.g., "Request Failed: 400 {...}")
 * without setting a `.status` property. Without this fallback, such errors
 * bypass the non-retryable check and trigger useless fallback/retry attempts
 * that will fail identically — wasting API calls and confusing the user.
 */
export function isNonRetryableClientError(err: unknown): boolean {
  if (hasHttpStatus(err)) {
    return err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 408;
  }
  // Fallback: extract HTTP status from the error message string.
  // Proxies, API gateways, and custom fetch wrappers often throw plain Error
  // objects like `new Error("Request Failed: 400 {body}")` or
  // `new Error("HTTP 403 Forbidden")` without a structured `.status` property.
  // The regex matches patterns like "400 {", ": 400 ", "HTTP 400", "status 401".
  if (err instanceof Error) {
    const match = err.message.match(/\b(4\d{2})\b/);
    if (match) {
      const status = parseInt(match[1], 10);
      if (status >= 400 && status < 500 && status !== 429 && status !== 408) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns true if the error is an abort-related DOMException
 * (AbortError from user Ctrl+C, or TimeoutError from AbortSignal.timeout).
 */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

// ── Backoff ──

/**
 * Compute backoff delay with ±25% jitter, capped at `maxDelayMs`.
 *
 * @param attempt     Zero-based attempt index (0 = first retry)
 * @param baseDelayMs Base delay in milliseconds (doubled per attempt)
 * @param maxDelayMs  Maximum delay cap. Without a cap, exponential backoff
 *                    grows unboundedly if maxRetries is ever increased or
 *                    made configurable (e.g., attempt 10 → 1024 × base).
 *                    Pass `Infinity` to disable the cap.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number = 30_000
): number {
  const base = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = base * JITTER_FACTOR * (2 * Math.random() - 1); // ±25%
  // Floor at 0 to prevent a negative delay if JITTER_FACTOR is ever increased
  // above 0.5 (or constants are made configurable). `setTimeout(-100)` fires
  // immediately in Node.js, but passing a negative value to `abortableSleep`
  // is semantically wrong and could behave differently in other runtimes.
  return Math.max(0, base + jitter);
}

// ── Signal combination ──

/**
 * Combine multiple AbortSignals into a single signal that aborts when any
 * of the input signals fires.
 *
 * Uses the native `AbortSignal.any()` when available (Node.js ≥ 20.3.0)
 * and falls back to a manual implementation using AbortController + event
 * listeners for older runtimes (e.g., Node.js 18).
 *
 * The fallback preserves the abort `reason` from whichever input signal
 * triggered first, so `AbortSignal.timeout()` errors still surface as
 * DOMException with `name: "TimeoutError"` rather than a generic
 * "AbortError".
 */
export function combineSignals(signals: AbortSignal[]): AbortSignal {
  // Native path — available in Node.js ≥ 20.3.0, modern browsers
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }

  // Fallback for Node.js 18 and other runtimes lacking AbortSignal.any()
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      // One of the input signals is already aborted — abort immediately,
      // preserving its reason (e.g., TimeoutError from AbortSignal.timeout).
      controller.abort(signal.reason);
      return controller.signal;
    }
  }

  // Build a handler for each signal and keep references so we can remove
  // them all once any signal fires (or the combined controller is aborted
  // externally).  Without this cleanup, each `combineSignals` call leaks a
  // listener on every long-lived input signal (e.g., the session-scoped
  // user abort controller) for the lifetime of that controller.
  const handlers: { signal: AbortSignal; handler: () => void }[] = [];

  const cleanup = () => {
    for (const entry of handlers) {
      entry.signal.removeEventListener("abort", entry.handler);
    }
  };

  for (const signal of signals) {
    const handler = () => {
      if (!controller.signal.aborted) {
        controller.abort(signal.reason);
      }
      // Regardless of whether *we* aborted the controller (another handler
      // may have beaten us in a synchronous re-entrant scenario), clean up
      // every listener so the input signals don't retain references to the
      // now-spent combined controller.
      cleanup();
    };
    handlers.push({ signal, handler });
    signal.addEventListener("abort", handler, { once: true });
  }

  return controller.signal;
}

// ── Error reason extraction ──

/**
 * Extract a short, human-readable reason from an API/network error for
 * inclusion in retry warning messages. Centralised here so all retry
 * paths (main loop, compaction, future callers) produce identical
 * phrasing and truncation, eliminating the previous silent divergence
 * between `loop.ts` (which handled 529 "API overloaded" and generic 5xx
 * separately) and `compaction.ts` (which only distinguished 429 vs. a
 * bare `HTTP <status>`).
 */
export function retryReasonFromError(err: unknown): string {
  if (hasHttpStatus(err)) {
    if (err.status === 429) return "rate limited (429)";
    if (err.status === 529) return "API overloaded (529)";
    if (err.status >= 500) return `server error (${err.status})`;
    return `HTTP ${err.status}`;
  }
  if (err instanceof Error) {
    // Network errors (ECONNRESET, ETIMEDOUT, etc.)
    if (hasErrnoCode(err)) {
      return err.code;
    }
    // Use safeTruncate to avoid splitting a surrogate pair at the cut
    // point. Only append the ellipsis when actual truncation occurred.
    if (err.message.length > 60) {
      return safeTruncate(err.message, 57) + "…";
    }
    return err.message;
  }
  return "unknown error";
}

// ── Abort-aware sleep ──

/**
 * Sleep for `ms` milliseconds, but reject immediately if the abort signal
 * fires. Cleans up its event listener and timer to avoid leaks.
 *
 * The timer is `unref()`'d so that if the Node.js process is shutting down
 * (e.g., the user exits during a retry backoff), the timer doesn't keep the
 * event loop alive — allowing a clean exit without dangling handles.
 */
export function abortableSleep(
  ms: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Prevent the timer from keeping the Node.js process alive during shutdown.
    // Without unref(), a long backoff delay (e.g., 30s) would block process.exit
    // for the full duration even after the user has Ctrl+C'd or the REPL has
    // closed — the event loop stays alive waiting for the timer to fire.
    if (typeof timer === "object" && typeof timer.unref === "function") {
      timer.unref();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
