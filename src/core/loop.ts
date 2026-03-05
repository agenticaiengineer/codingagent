import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config/config.js";
import { getClient } from "./client.js";
import { StreamingToolExecutor } from "./streaming-executor.js";
import { toolsToAnthropicFormat, findTool } from "../tools/index.js";
import { printWarning } from "../ui/ui.js";
import { hasErrnoCode, safeTruncate } from "../tools/validate.js";
import {
  hasHttpStatus,
  isNonRetryableClientError,
  isAbortError,
  backoffDelay as sharedBackoffDelay,
  abortableSleep,
  retryReasonFromError,
} from "../utils/retry.js";
import { repairOrphanedToolUse } from "./compaction.js";
import {
  evaluateWork,
  buildRefinementMessage,
  MAX_EVAL_ROUNDS,
  DEFAULT_JUDGES,
} from "../eval/eval.js";
import {
  debugLogApiRequest,
  debugLogApiResponse,
  debugLogToolExecution,
  debugLog,
} from "./debug.js";
import type {
  Message,
  Tool,
  ToolContext,
  LoopYield,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "./types.js";

// ── Retry logic with exponential backoff ──

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Maximum number of tool calls the model may emit in a single API response.
 * Without a cap, a model hallucination or adversarial prompt could produce
 * hundreds of tool_use blocks in one response, causing hundreds of tool
 * executions (each consuming time, potentially API credits for sub-agents,
 * and memory for results). 50 is generous for any realistic use case (typical
 * responses contain 1–5 tool calls) while preventing runaway cost. Excess
 * tool_use blocks are skipped with synthetic error results so the API's
 * tool_use/tool_result pairing constraint is still satisfied.
 */
const MAX_TOOL_CALLS_PER_TURN = 50;
/** Maximum backoff delay in milliseconds. Without a cap, exponential
 *  backoff grows unboundedly if MAX_RETRIES is ever increased or made
 *  configurable (e.g., attempt 10 → 1024s ≈ 17 minutes).  30 seconds
 *  is long enough to ride out transient 429/5xx flurries while remaining
 *  tolerable for the user, who can always Ctrl+C to abort the wait. */
const MAX_DELAY_MS = 30_000;

// hasHttpStatus, isNonRetryableClientError, backoffDelay, abortableSleep
// are imported from ./retry.js (shared with compaction.ts).

/** Local wrapper that binds BASE_DELAY_MS and MAX_DELAY_MS. */
function backoffDelay(attempt: number): number {
  return sharedBackoffDelay(attempt, BASE_DELAY_MS, MAX_DELAY_MS);
}

/**
 * Map common network-level (non-HTTP) errors to actionable user guidance.
 * Returns a hint string, or null if no specific guidance applies.
 * Separate from `apiErrorHint` which handles HTTP status codes — these
 * errors occur at the TCP/TLS layer before an HTTP response is received.
 */
function networkErrorHint(err: unknown): string | null {
  if (!hasErrnoCode(err)) return null;
  switch (err.code) {
    case "ECONNRESET":
      return "Hint: The connection was reset by the server or a proxy. If using a reverse proxy or VPN, check that it allows long-lived streaming connections. Large requests may exceed proxy buffer limits.";
    case "ECONNREFUSED":
      return "Hint: The connection was refused. Check that ANTHROPIC_BASE_URL is correct and the API server is running. If using a local proxy, verify it's started.";
    case "ENOTFOUND":
      return "Hint: The hostname could not be resolved (DNS failure). Check your internet connection, DNS settings, and ANTHROPIC_BASE_URL.";
    case "ETIMEDOUT":
      return "Hint: The connection timed out before the server responded. This usually indicates a network issue, firewall blocking, or an unreachable server. Check your network connection.";
    case "EPIPE":
    case "ERR_SOCKET_CLOSED":
      return "Hint: The connection was closed unexpectedly. If using a reverse proxy, it may have closed the connection due to an idle timeout or request size limit.";
    default:
      return null;
  }
}

/**
 * Map common API error status codes to actionable user guidance.
 * Returns a hint string, or null if no specific guidance applies.
 */
function apiErrorHint(err: unknown): string | null {
  if (!hasHttpStatus(err)) return null;
  switch (err.status) {
    case 401:
      return "Hint: Check that ANTHROPIC_API_KEY is set correctly. It should start with \"sk-ant-\".";
    case 403:
      return "Hint: Your API key may lack permissions for this model, or the model may require a different plan.";
    case 400: {
      // Inspect the message for context-length errors to suggest /compact
      const msg = err instanceof Error ? err.message : "";
      if (/context|token|too.long|max.*length/i.test(msg)) {
        return "Hint: The conversation context may be too large. Try /compact to reduce it.";
      }
      return "Hint: The request was rejected. Check /model to verify the model name, or try /compact if the context is large.";
    }
    case 404:
      return "Hint: The model was not found. Check your model name with /model — it may be misspelled or unavailable.";
    // 408 Request Timeout: typically from reverse proxies (nginx, Cloudflare)
    // or API gateways that impose their own request timeouts. The Anthropic
    // API itself doesn't return 408, but proxied setups commonly do — especially
    // for long-running streaming responses that exceed the proxy's read timeout.
    // Without this hint, the user sees "HTTP 408" with no guidance, and the
    // retry logic will retry (408 is not in the isNonRetryableClientError range
    // since status 408 < 429 but we explicitly handle it here for the hint).
    case 408:
      return "Hint: The request timed out (408). If using a reverse proxy, its read timeout may be too short for streaming responses. Try increasing the proxy's timeout or check your network connection.";
    // 502/503/504 gateway errors: common when using a reverse proxy or
    // load balancer between the client and the Anthropic API. These indicate
    // the proxy couldn't reach the upstream server, the upstream is temporarily
    // unavailable, or the upstream took too long to respond. The retry logic
    // already retries these (5xx), but a hint helps the user understand why
    // retries are happening and what to check if they persist.
    case 502:
      return "Hint: Bad Gateway (502). The upstream API server may be temporarily unreachable. If using a reverse proxy, check that ANTHROPIC_BASE_URL is correct and the proxy can reach the API.";
    case 503:
      return "Hint: Service temporarily unavailable (503). The API server is overloaded or under maintenance. Wait a moment and try again.";
    case 504:
      return "Hint: Gateway Timeout (504). The API server didn't respond in time. If using a reverse proxy, try increasing its timeout. For long conversations, try /compact to reduce request size.";
    case 529:
      return "Hint: The Anthropic API is temporarily overloaded. Wait a moment and try again.";
    default:
      return null;
  }
}

/**
 * Call the Anthropic API with retry + exponential backoff.
 * Retries on server errors (5xx) and 429 (rate limit).
 * Does NOT retry on other 4xx errors (bad request, auth, etc.).
 */
async function callWithRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      // Abort errors (user Ctrl+C or timeout): bail immediately.
      // Without this check, an AbortError has no HTTP status, so it falls
      // through isNonRetryableClientError (which only checks 4xx status
      // codes), reaches the backoff path, and wastes a retry attempt +
      // sleep time before the `signal.aborted` check at the top of the
      // next iteration catches it. This matches the pattern already used
      // in compactionCallWithRetry (compaction.ts line ~49).
      if (isAbortError(err)) {
        throw err;
      }

      // Non-retryable client errors: bail immediately
      if (isNonRetryableClientError(err)) {
        throw err;
      }

      // Out of retries
      if (attempt >= MAX_RETRIES) {
        throw err;
      }

      // Wait with backoff before next attempt
      const delay = backoffDelay(attempt);
      const reason = retryReasonFromError(err);
      printWarning(
        `API call failed (${reason}). Retrying in ${(delay / 1000).toFixed(1)}s (retry ${attempt + 1}/${MAX_RETRIES})…`
      );
      await abortableSleep(delay, signal);
    }
  }
  // Should never reach here, but TypeScript needs it
  throw lastError ?? new Error("Unexpected: retry loop exhausted without capturing an error");
}

// ── Helpers ──

/**
 * Safely coerce `block.input` (typed as `unknown` in the SDK) to
 * `Record<string, unknown>`. If the API returns `null`, `undefined`,
 * or a non-object, we fall back to an empty object so downstream tool
 * execution doesn't crash with "Cannot read properties of null".
 */
function safeToolInput(input: unknown): Record<string, unknown> {
  if (input != null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

// ── Streaming API call ──

interface StreamResult {
  response: Anthropic.Message;
  textDeltas: string[];
  toolUseBlocks: ToolUseBlock[];
}

/**
 * Call the Anthropic API using the streaming endpoint.
 * Yields text deltas in real-time via the onTextDelta callback.
 *
 * **Streaming tool execution (§14.1):** As each tool_use content block is
 * fully received from the stream, the `onToolUse` callback fires immediately,
 * allowing the StreamingToolExecutor to begin executing tools DURING the API
 * response — before the model finishes generating subsequent tool calls.
 * For a response with 5 Read calls, all 5 may complete before the model emits
 * its final text. This overlaps file I/O and network operations with token
 * generation, significantly reducing end-to-end latency for tool-heavy turns.
 *
 * Falls back to non-streaming on stream-specific errors.
 *
 * When `config.disableStreaming` is true, skips the streaming attempt entirely
 * and calls `client.messages.create()` directly. This avoids the streaming
 * round-trip for environments where SSE isn't supported (reverse proxies,
 * mock servers, etc.). The `onTextDelta` and `onToolUse` callbacks are still
 * fired from the non-streaming response, so the rest of the pipeline
 * (StreamingToolExecutor, text delta yielding) works identically.
 */
async function callStreamingApi(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  signal: AbortSignal,
  onTextDelta: (text: string) => void,
  onToolUse: (toolUse: ToolUseBlock) => void
): Promise<StreamResult> {
  const config = getConfig();

  // ── Non-streaming fast path ──
  // When streaming is disabled (ANTHROPIC_DISABLE_STREAMING=1), skip the
  // streaming attempt entirely and call the non-streaming API directly.
  // This avoids the streaming→fallback round-trip for environments that
  // don't support SSE (reverse proxies, mock servers for integration tests,
  // corporate firewalls that buffer chunked responses, etc.).
  if (config.disableStreaming) {
    const response = await client.messages.create(params, { signal });

    const textDeltas: string[] = [];
    const toolUseBlocks: ToolUseBlock[] = [];

    for (const block of response.content ?? []) {
      if (block.type === "text") {
        textDeltas.push(block.text);
        onTextDelta(block.text);
      } else if (block.type === "tool_use") {
        const toolUseBlock: ToolUseBlock = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: safeToolInput(block.input),
        };
        toolUseBlocks.push(toolUseBlock);
        onToolUse(toolUseBlock);
      }
    }

    return { response, textDeltas, toolUseBlocks };
  }

  // ── Streaming path (default) ──
  const textDeltas: string[] = [];
  const toolUseBlocks: ToolUseBlock[] = [];
  let streamedTextCount = 0;

  try {
    const stream = client.messages.stream(
      {
        ...params,
        stream: true,
      } as Anthropic.MessageCreateParamsStreaming,
      { signal }
    );

    stream.on("text", (text) => {
      textDeltas.push(text);
      streamedTextCount++;
      onTextDelta(text);
    });

    stream.on("contentBlock", (block) => {
      if (block.type === "tool_use") {
        const toolUseBlock: ToolUseBlock = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: safeToolInput(block.input),
        };
        toolUseBlocks.push(toolUseBlock);
        // Fire the callback immediately so the StreamingToolExecutor can
        // begin executing this tool while the stream continues generating
        // subsequent tool_use blocks. This is the core of the streaming
        // tool execution pattern (§14.1): addTool() → processQueue() →
        // tool starts running, all while the API stream is still open.
        onToolUse(toolUseBlock);
      }
    });

    const finalMessage = await stream.finalMessage();

    return {
      response: finalMessage,
      textDeltas,
      toolUseBlocks,
    };
  } catch (err: unknown) {
    // If the signal was aborted, rethrow so the caller handles it
    if (signal.aborted) throw err;

    // Don't fall back on non-retryable client errors (400, 401, 403, etc.)
    // — the non-streaming endpoint would reject the exact same request, so
    // falling back just wastes an API call and doubles the wait time. Let
    // callWithRetry handle these by re-throwing immediately.
    if (isNonRetryableClientError(err)) throw err;

    // Fall back to non-streaming on stream-related errors (network issues,
    // stream parsing failures, etc.).
    // Log the original error so it's not silently swallowed.
    const streamErr = err instanceof Error ? err.message : String(err);
    printWarning(`Streaming failed (${streamErr}), falling back to non-streaming API call.`);

    // ── Non-streaming fallback with its own retry ──
    // The fallback gets up to FALLBACK_MAX_RETRIES additional attempts with
    // short backoff. Without this, a transient 429/503/ECONNRESET on the
    // fallback call propagates up to callWithRetry, which counts it as one
    // attempt and starts a NEW streaming attempt on the next retry — wasting
    // 2 API calls per retry cycle (stream + fallback). By retrying the
    // non-streaming call here, we avoid the redundant streaming re-attempt
    // and resolve transient errors faster.
    const FALLBACK_MAX_RETRIES = 2;
    const FALLBACK_BASE_DELAY_MS = 1000;
    let lastFallbackErr: unknown;

    for (let fallbackAttempt = 0; fallbackAttempt <= FALLBACK_MAX_RETRIES; fallbackAttempt++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      try {
        const response = await client.messages.create(params, { signal });

        const fallbackToolUseBlocks: ToolUseBlock[] = [];
        const fallbackTextDeltas: string[] = [];

        // Guard with `?? []` in case the API returns null/undefined content —
        // matching the same defensive pattern used on the main response path
        // (line ~519). The non-streaming fallback was missing this guard, so a
        // proxy or future API version returning null content would crash with
        // `TypeError: response.content is not iterable`, surfacing as a
        // confusing "non-streaming fallback also failed" error with no
        // indication that the response was structurally invalid.
        for (const block of response.content ?? []) {
          if (block.type === "text") {
            fallbackTextDeltas.push(block.text);
            // Only fire onTextDelta if no text was already emitted during the
            // (failed) streaming attempt. When the stream partially succeeds
            // (emitting some text deltas via onTextDelta before erroring), the
            // non-streaming fallback retrieves the COMPLETE response — including
            // the text already emitted. Re-emitting via onTextDelta would push
            // duplicates into pendingDeltas, causing the user to see the
            // beginning of the response twice. The fallback text is still
            // captured in fallbackTextDeltas (and returned in StreamResult) for
            // response reconstruction; we just skip the live callback.
            if (streamedTextCount === 0) {
              onTextDelta(block.text);
            }
          } else if (block.type === "tool_use") {
            const toolUseBlock: ToolUseBlock = {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: safeToolInput(block.input),
            };
            fallbackToolUseBlocks.push(toolUseBlock);
            // In the non-streaming fallback, all blocks arrive at once.
            // We still fire onToolUse for each block so the executor can
            // begin parallel execution immediately rather than waiting for
            // the full response to be iterated.
            onToolUse(toolUseBlock);
          }
        }

        return {
          response,
          textDeltas: fallbackTextDeltas,
          toolUseBlocks: fallbackToolUseBlocks,
        };
      } catch (fallbackErr: unknown) {
        lastFallbackErr = fallbackErr;

        // Abort errors: bail immediately
        if (isAbortError(fallbackErr)) throw fallbackErr;

        // Non-retryable client errors (400, 401, 403, etc.): bail immediately.
        // The same request would fail identically on retry.
        if (isNonRetryableClientError(fallbackErr)) {
          // Preserve HTTP status for callWithRetry's error classification.
          throw fallbackErr;
        }

        // Out of fallback retries — propagate to callWithRetry
        if (fallbackAttempt >= FALLBACK_MAX_RETRIES) break;

        // Wait with backoff before next fallback attempt
        const delay = sharedBackoffDelay(fallbackAttempt, FALLBACK_BASE_DELAY_MS, MAX_DELAY_MS);
        const reason = retryReasonFromError(fallbackErr);
        printWarning(
          `Non-streaming fallback failed (${reason}). Retrying in ${(delay / 1000).toFixed(1)}s (fallback retry ${fallbackAttempt + 1}/${FALLBACK_MAX_RETRIES})…`
        );
        await abortableSleep(delay, signal);
      }
    }

    // All fallback retries exhausted. Re-throw with preserved error properties
    // so callWithRetry can properly classify and potentially retry at the
    // outer level.
    if (hasHttpStatus(lastFallbackErr)) {
      throw lastFallbackErr;
    }
    if (hasErrnoCode(lastFallbackErr)) {
      throw lastFallbackErr;
    }
    const fallbackMsg = lastFallbackErr instanceof Error ? (lastFallbackErr as Error).message : String(lastFallbackErr);
    throw new Error(
      `API call failed. Streaming error: ${streamErr}. Non-streaming fallback also failed after ${FALLBACK_MAX_RETRIES + 1} attempts: ${fallbackMsg}`
    );
  }
}

// ── Core agentic loop ──

/**
 * Core agentic loop. Streams API responses, executes tools in parallel,
 * and loops until the model stops calling tools.
 *
 * When `enableEval` is true, the loop runs a multi-judge evaluation step
 * after the model indicates completion (end_turn with no tool calls).
 * Multiple judges evaluate the work from different perspectives
 * (correctness, completeness, goal alignment). The work is accepted
 * only when a majority of judges agree it's complete. Otherwise, the
 * judges' feedback is injected as a refinement prompt and the loop
 * continues. This eval-refine cycle repeats up to MAX_EVAL_ROUNDS times.
 *
 * Eval is disabled by default and for sub-agents (depth > 0) to avoid
 * recursive eval overhead — only the root agent's final output needs
 * verification.
 */
export async function* agenticLoop(
  messages: Message[],
  systemPrompt: string,
  tools: readonly Tool[],
  context: ToolContext,
  model?: string,
  maxTurns?: number,
  enableEval?: boolean
): AsyncGenerator<LoopYield> {
  const config = getConfig();
  const client = getClient();
  const effectiveModel = model ?? config.model;
  // Convert tools to Anthropic format, but pass `undefined` instead of an empty
  // array. The Anthropic API requires `tools` to be either absent/undefined or a
  // non-empty array — sending `tools: []` returns a 400 error ("tools: must have
  // at least 1 item"). In practice, `tools` is always non-empty because the REPL
  // and agent.ts use the full tool registry, but `resolveTools()` with a restrictive
  // allow/disallow filter could produce an empty list, and future callers might
  // pass an empty array directly.
  const anthropicTools = tools.length > 0 ? toolsToAnthropicFormat(tools) : undefined;
  let turnCount = 0;

  // Guard against callers passing an empty messages array. The Anthropic API
  // requires at least one message (with role: "user") and will reject an empty
  // array with a 400 error. In practice, the REPL and agent.ts always push a
  // user message before calling agenticLoop, but this guard protects against
  // future code paths or direct callers that might pass `[]`. Without it, the
  // user would see a raw "400 Bad Request" error with no actionable context.
  if (messages.length === 0) {
    yield {
      type: "error",
      error: "Cannot start agentic loop: messages array is empty. At least one user message is required.",
    };
    return;
  }
  // Clamp to at least 1 to guard against direct callers passing maxTurns: 0,
  // negative, or NaN values. The Task tool already validates its own maxTurns,
  // but agenticLoop itself should be defensive against all callers. Without
  // this, maxTurns: 0 would skip the while loop entirely and emit a confusing
  // "Maximum turns (0) reached" error. NaN is especially dangerous because
  // Math.max(1, NaN) returns NaN, causing `turnCount < NaN` to be false on
  // every iteration, so the loop body never executes and the agent silently
  // does nothing, emitting only "Maximum turns (NaN) reached".
  const rawMaxTurns = maxTurns ?? 100;
  const effectiveMaxTurns = Number.isFinite(rawMaxTurns)
    ? Math.max(1, rawMaxTurns)
    : 100;

  // ── Eval gate state ──
  // Only enable eval for root-level agents (depth 0) when explicitly
  // requested. Sub-agents (depth > 0) skip eval to avoid recursive
  // eval overhead and excessive API calls. Each eval round runs all
  // judges in parallel, so the cost is O(judges × rounds) API calls.
  const effectiveEnableEval = enableEval === true && context.depth === 0;
  let evalRound = 0;

  // Track whether we've already shown the 75% and 90% warnings so we
  // don't repeat them on subsequent turns.
  let warned75 = false;
  let warned90 = false;

  while (turnCount < effectiveMaxTurns) {
    if (context.abortController.signal.aborted) {
      yield { type: "error", error: "Aborted" };
      return;
    }

    turnCount++;

    // Warn as turns approach the limit so the model/user can wrap up
    // before hitting the hard cap. Only warn for limits ≥ 10 (small limits
    // are intentional, e.g., sub-agents with maxTurns: 5) and only at
    // the root agent level (sub-agents don't have a REPL to act on warnings).
    if (effectiveMaxTurns >= 10 && context.depth === 0) {
      const pct = turnCount / effectiveMaxTurns;
      if (!warned75 && pct >= 0.75 && pct < 0.9) {
        warned75 = true;
        printWarning(
          `Turn ${turnCount}/${effectiveMaxTurns} — approaching turn limit. Consider wrapping up or using /compact to free context.`
        );
      } else if (!warned90 && pct >= 0.9) {
        warned90 = true;
        printWarning(
          `Turn ${turnCount}/${effectiveMaxTurns} — nearly at turn limit. Finish the current task soon to avoid hitting the cap.`
        );
      }
    }

    // ── API call with streaming, retry, and timing ──
    yield { type: "api_call_start" };
    const apiStart = performance.now();

    // ── Pre-call message repair ──
    // Repair orphaned tool_use/tool_result blocks before sending messages
    // to the API. Orphans can arise from:
    //   - Ctrl+C abort: assistant message with tool_use was pushed but the
    //     matching tool_result user message was never added
    //   - Retry after stream failure: resetForRetry discards partial tools
    //     but the assistant message with their tool_use IDs is already in
    //     messages from the previous turn
    //   - Compaction: summarization may drop user tool_result messages
    // Without this, the API rejects the request with:
    //   400 "unexpected tool_use_id found in tool_result blocks"
    // or 400 "each tool_use must have a corresponding tool_result"
    // Previously, repair only ran AFTER a turn completed (in the caller),
    // so mid-loop corruption caused 400 errors that exhausted retries.
    repairOrphanedToolUse(messages);

    // Accumulate text deltas yielded during streaming.
    // Use an index cursor (`deltaIdx`) instead of `Array.shift()` to drain
    // the buffer.  `shift()` is O(n) per call because it re-indexes the
    // entire array, making the drain loops O(n²) over the lifetime of a
    // streaming response with many small text deltas (typical: hundreds of
    // single-word/sentence fragments).  With the cursor, each element is
    // visited exactly once (O(n) total), and the array is cleared in bulk
    // after each drain pass.
    const pendingDeltas: string[] = [];
    let deltaIdx = 0;
    let deltaResolve: (() => void) | null = null;

    const onTextDelta = (text: string): void => {
      pendingDeltas.push(text);
      if (deltaResolve) {
        deltaResolve();
        deltaResolve = null;
      }
    };

    const apiParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: effectiveModel,
      max_tokens: config.maxOutputTokens,
      system: systemPrompt,
      messages: messages as Anthropic.MessageParam[],
      tools: anthropicTools,
    };

    // ── Debug: log outgoing API request ──
    debugLogApiRequest({
      model: effectiveModel,
      max_tokens: config.maxOutputTokens,
      system: systemPrompt,
      messages: messages,
      tools: anthropicTools,
      callSite: "agenticLoop",
    });

    // ── Streaming tool execution (§14.1) ──
    // Create the StreamingToolExecutor BEFORE the streaming call so tools
    // can begin executing DURING the API response stream. As each tool_use
    // content block arrives from the stream, the onToolUse callback fires
    // addTool() immediately, which triggers processQueue() and may start
    // tool execution while the model is still generating subsequent blocks.
    //
    // This means a Read tool call at the beginning of a response can finish
    // before the model finishes generating subsequent tool calls — file I/O,
    // grep operations, and web fetches overlap with token generation.
    //
    // The executor is created unconditionally (even if the response may not
    // contain tool calls) because the cost is negligible (a few object
    // allocations) and we can't know whether tools will appear until the
    // stream is in progress.
    const executor = new StreamingToolExecutor(context, tools);

    // Track tool_use blocks received during streaming for the cap check
    // and UI yield events. The executor receives them via addTool() during
    // the stream; this array collects them for post-stream bookkeeping
    // (cap enforcement, excess synthetic errors, tool_use yield events).
    const streamingToolUseBlocks: ToolUseBlock[] = [];
    /** Count of tools already added to the executor during streaming.
     *  Once this reaches MAX_TOOL_CALLS_PER_TURN, subsequent tool_use
     *  blocks are collected but NOT added to the executor. */
    let streamingToolCount = 0;

    // `activeExecutor` tracks the current executor instance. On retries
    // (see resetForRetry below), a fresh executor replaces the original to
    // discard tools from the failed attempt. Declared here (before onToolUse)
    // so the closure captures the mutable binding.
    let activeExecutor = executor;

    const onToolUse = (toolUse: ToolUseBlock): void => {
      streamingToolUseBlocks.push(toolUse);
      // Enforce the per-turn cap during streaming. Without this, a model
      // hallucination emitting hundreds of tool_use blocks would feed all
      // of them to the executor during the stream, bypassing the cap.
      if (streamingToolCount < MAX_TOOL_CALLS_PER_TURN) {
        streamingToolCount++;
        activeExecutor.addTool(toolUse);
      }
    };

    // Reset function called at the start of each retry attempt inside
    // callWithRetry. If a previous streaming attempt partially succeeded
    // (emitting some contentBlock events before failing), onToolUse would
    // have been called — adding tools to the executor and tracking array.
    // On retry, the new response produces different tool_use block IDs, so
    // the executor's seenIds dedup wouldn't catch them, leading to duplicate
    // tool execution (stale tools from the failed attempt + new tools from
    // the retry). Resetting ensures each retry attempt starts clean.
    //
    // NOTE: We create a fresh executor rather than trying to reset the existing
    // one, since tools from the failed attempt may already be executing
    // asynchronously and their fire-and-forget promises reference the old
    // executor's internal state. The old executor is abandoned (its in-flight
    // tools will complete harmlessly since their results are never collected).
    const resetForRetry = (): void => {
      // Always reset text deltas — a previous attempt may have partially
      // streamed text (via onTextDelta → pendingDeltas) before failing.
      // Without this, the retry's onTextDelta pushes new deltas onto the
      // same array, and the consumer loop yields both the stale partial
      // deltas from the failed attempt AND the complete deltas from the
      // retry — producing duplicate/garbled text output. This must happen
      // unconditionally (not gated on streamingToolUseBlocks.length) because
      // a stream can fail after emitting text deltas but before any
      // tool_use blocks arrive.
      pendingDeltas.length = 0;
      deltaIdx = 0;

      if (streamingToolUseBlocks.length > 0 || streamingToolCount > 0) {
        // Only reset if the previous attempt actually received tool_use blocks.
        // Avoid creating a new executor on the first attempt or when the
        // previous attempt failed before any contentBlock events.
        activeExecutor = new StreamingToolExecutor(context, tools);
        streamingToolUseBlocks.length = 0;
        streamingToolCount = 0;
      }
    };

    // We run the streaming call as a background promise so we can yield
    // text deltas in real-time while the stream is still open.
    let streamResult: StreamResult | null = null;
    let streamError: unknown = null;
    let streamDone = false;

    const streamPromise = callWithRetry(
      () => {
        resetForRetry();
        return callStreamingApi(
          client,
          apiParams,
          context.abortController.signal,
          onTextDelta,
          onToolUse
        );
      },
      context.abortController.signal
    ).then(
      (result) => {
        streamResult = result;
      },
      (err) => {
        streamError = err;
      }
    ).finally(() => {
      streamDone = true;
      // Ensure the delta consumer loop exits
      if (deltaResolve) {
        deltaResolve();
        deltaResolve = null;
      }
    });

    // Yield text deltas as they arrive from the stream
    while (!streamDone) {
      // Drain any buffered deltas using the cursor (O(1) per element
      // vs O(n) for shift())
      while (deltaIdx < pendingDeltas.length) {
        yield { type: "assistant_text", text: pendingDeltas[deltaIdx++] };
      }
      // Remove only the drained portion. Using `splice(0, deltaIdx)` instead
      // of `pendingDeltas.length = 0` is critical: `onTextDelta` may push a
      // new element between the drain loop ending (line above) and this point.
      // Setting `length = 0` would silently discard that element because it
      // mutates the array's length *after* the push has already occurred.
      // `splice` only removes the entries we've already yielded, preserving
      // any new entries pushed concurrently by the streaming callback.
      if (deltaIdx > 0) {
        pendingDeltas.splice(0, deltaIdx);
        deltaIdx = 0;
      }

      // Check if the stream is done
      if (streamDone) break;

      // Wait for the next delta or stream completion
      await new Promise<void>((resolve) => {
        deltaResolve = resolve;
        // If there are already pending deltas or the stream finished
        // while we set up the waiter, resolve immediately
        if (deltaIdx < pendingDeltas.length || streamDone) {
          resolve();
          deltaResolve = null;
        }
      });
    }

    // Drain any final buffered deltas
    while (deltaIdx < pendingDeltas.length) {
      yield { type: "assistant_text", text: pendingDeltas[deltaIdx++] };
    }
    // Release all delta string references now that they've been yielded.
    // Without this, the pendingDeltas array retains references to every
    // text fragment from the entire streaming response (typically hundreds
    // of small strings totaling the full response text). These references
    // stay alive until the generator function exits — which can be much
    // later, since tool execution (below) can take seconds or minutes
    // (e.g., a Bash command with a long timeout, or a sub-agent Task).
    // During that time, V8 cannot GC any of the delta strings despite
    // them being fully consumed. Clearing the array releases the strings
    // immediately, reducing peak memory by the size of the response text
    // (~10–100 KB for typical responses, more for verbose model output).
    pendingDeltas.length = 0;

    // Wait for the promise to fully settle (should already be done)
    await streamPromise;

    const apiDurationMs = performance.now() - apiStart;

    // Handle errors
    if (streamError !== null || streamResult === null) {
      if (context.abortController.signal.aborted) {
        yield { type: "api_call_end", durationMs: apiDurationMs };
        yield { type: "error", error: "Aborted" };
        return;
      }
      const msg =
        streamError instanceof Error
          ? streamError.message
          // The Anthropic SDK's error classes extend Error, but reverse proxies
          // or custom middleware could throw plain objects with a `.message`
          // string. `String({message: "foo"})` produces `[object Object]` —
          // completely unhelpful. Extract `.message` if it exists and is a
          // string before falling back to `String()`.
          : (streamError != null &&
             typeof streamError === "object" &&
             "message" in streamError &&
             typeof (streamError as { message: unknown }).message === "string")
            ? (streamError as { message: string }).message
            : String(streamError ?? "Unknown API error");
      // Cap the error message length. Reverse proxies, API gateways, and
      // corporate middleware can return error responses with multi-KB HTML
      // bodies (full error pages, stack traces, debug dumps). Without a
      // cap, the entire blob is yielded as the error message and injected
      // into the conversation context — wasting tokens, potentially
      // triggering auto-compaction, and producing unreadable output. The
      // 2000-char limit retains enough detail for diagnosis while keeping
      // the error concise.
      const truncatedMsg = msg.length > 2000
        ? safeTruncate(msg, 2000) + " ... (error message truncated)"
        : msg;
      // Append actionable guidance for common API error status codes or
      // network-level errors so the user knows what to do instead of seeing
      // a raw HTTP status or errno code.
      const hint = apiErrorHint(streamError) ?? networkErrorHint(streamError);
      // Include the model name and HTTP status code in the error so the user
      // can immediately see which model was attempted (especially useful for
      // 404 "model not found" errors where the model name may be misspelled)
      // and which HTTP status caused the failure. Previously, when
      // `apiErrorHint()` returned null (non-hinted status codes like 402
      // Payment Required, 405 Method Not Allowed, 409 Conflict, 451
      // Unavailable For Legal Reasons, etc.), the status code was only visible
      // if the SDK included it in the error message text — which varies by SDK
      // version and error type. Explicitly prefixing "HTTP <status>" makes the
      // status code reliably visible for ALL HTTP errors, not just the ones
      // with dedicated hints. For network-level errors (no HTTP status), the
      // prefix is omitted since there's no status code to show.
      const statusPrefix = hasHttpStatus(streamError) ? `HTTP ${streamError.status} ` : "";
      // Truncate the model name to prevent a misconfigured or hallucinated model
      // string (e.g., a multi-KB garbage value from a corrupt env var) from
      // inflating the error message. The error is yielded as a LoopYield event
      // and often injected into the conversation context, so an unbounded model
      // name wastes context tokens. Real model identifiers are 30–60 chars; 80
      // is generous while capping pathological values.
      const displayModel = effectiveModel.length > 80
        ? safeTruncate(effectiveModel, 77) + "…"
        : effectiveModel;
      yield { type: "api_call_end", durationMs: apiDurationMs };
      yield { type: "error", error: hint ? `API error (model: ${displayModel}): ${statusPrefix}${truncatedMsg}\n${hint}` : `API error (model: ${displayModel}): ${statusPrefix}${truncatedMsg}` };
      return;
    }

    // At this point streamResult is guaranteed non-null.
    // We assign to a const so TypeScript can narrow the type correctly
    // (it can't narrow variables that are reassigned in async callbacks).
    const result: StreamResult = streamResult;

    // ── Debug: log raw API response ──
    debugLogApiResponse({
      callSite: "agenticLoop",
      model: result.response.model,
      stopReason: result.response.stop_reason,
      usage: result.response.usage,
      content: result.response.content ?? [],
      durationMs: apiDurationMs,
    });

    // Emit api_call_end with timing and usage
    yield {
      type: "api_call_end",
      durationMs: apiDurationMs,
      usage: {
        inputTokens: result.response.usage?.input_tokens ?? 0,
        outputTokens: result.response.usage?.output_tokens ?? 0,
      },
    };

    // Build assistant message from response content.
    // Guard with `?? []` in case the API returns a null/undefined content array
    // (e.g., an unexpected response shape from a future API version or a proxy
    // that strips the content field). Without this, `for...of` on null/undefined
    // throws `TypeError: result.response.content is not iterable`, crashing the
    // agentic loop with no actionable error message.
    const assistantContent: ContentBlock[] = [];

    for (const block of result.response.content ?? []) {
      if (block.type === "text") {
        assistantContent.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        assistantContent.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: safeToolInput(block.input),
        });
      } else if (block.type === "thinking") {
        // Extended thinking blocks contain the model's chain-of-thought
        // reasoning. The API requires these to be preserved in the
        // conversation history for subsequent calls — omitting them can
        // cause 400 errors or degrade model quality, since the model
        // expects to see its own reasoning to maintain coherence.
        // The `signature` field is an opaque integrity token that MUST
        // be echoed back verbatim — omitting it causes a 400 error.
        assistantContent.push({
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        });
      } else if (block.type === "redacted_thinking") {
        // Redacted thinking blocks are opaque (safety-filtered reasoning).
        // The API requires them to be echoed back in conversation history
        // exactly as received. Dropping them would produce an inconsistent
        // context that the API may reject or handle incorrectly.
        assistantContent.push({
          type: "redacted_thinking",
          data: block.data,
        });
      }
      // Unknown block types are silently ignored — the API may introduce
      // new block types in the future, and including unrecognized types
      // could cause serialization issues.
    }

    const assistantMessage: Message = {
      role: "assistant",
      content: assistantContent,
    };
    messages.push(assistantMessage);

    // If no tool calls, we're done.
    // Use streamingToolUseBlocks (populated during the stream via onToolUse
    // callback) rather than result.toolUseBlocks — the two arrays should
    // contain the same data, but streamingToolUseBlocks is the authoritative
    // source since the executor was already fed from it during streaming.
    if (streamingToolUseBlocks.length === 0) {
      // Warn when the API stops due to max_tokens — the model's response
      // was truncated mid-output because it exceeded the configured output
      // token limit. Without a warning, the user sees text that ends
      // mid-sentence with no explanation. This is especially confusing for
      // long code generation or explanations where the truncation looks
      // like the model simply stopped responding. The user needs to know
      // they can increase ANTHROPIC_MAX_OUTPUT_TOKENS or ask the model to
      // continue. This complements the max_tokens + tool calls warning
      // (line ~594+) which fires when the loop CONTINUES despite truncation.
      if (result.response.stop_reason === "max_tokens") {
        printWarning(
          `Model response was truncated (hit max_tokens limit of ${config.maxOutputTokens.toLocaleString()}). ` +
          `The output may be incomplete. Ask the model to "continue" or increase ANTHROPIC_MAX_OUTPUT_TOKENS.`
        );
      }
      // Warn when the API stops due to content filtering — the model's
      // response may have been truncated or modified, but without a warning
      // the user has no indication that content was filtered. This is
      // distinct from `max_tokens` (which is about length) — content_filter
      // means the safety system intervened, and the user should know.
      // Compare via `String()` to avoid `as string` cast while remaining
      // forward-compatible — the SDK's stop_reason type doesn't include
      // "content_filter" yet, but the API can return it at runtime.
      // Our `StopReason` type in types.ts includes it for downstream consumers.
      if (String(result.response.stop_reason) === "content_filter") {
        printWarning(
          "Model response was stopped by content filtering. The output may be incomplete or modified."
        );
      }
      // Warn when the API indicates stop_reason "tool_use" but no tool_use
      // blocks were extracted. This can happen when:
      //   1. A streaming parse error corrupted the tool_use block's JSON
      //   2. A network interruption delivered an incomplete tool_use block
      //      that the SDK silently dropped
      //   3. The non-streaming fallback received a response where all
      //      tool_use blocks had unrecognized shapes (neither "text" nor
      //      "tool_use" type matched in callStreamingApi's fallback loop)
      // Without this warning, the loop exits silently as if the model chose
      // to stop (end_turn), and the user has no indication that tool calls
      // were intended but lost. The model "wanted" to act but couldn't —
      // the user should retry or check for network issues.
      if (result.response.stop_reason === "tool_use") {
        printWarning(
          "Model intended to call tools (stop_reason: tool_use) but no tool calls were received. " +
          "This may indicate a streaming or network issue. Try sending your message again."
        );
      }
      // Warn when the model returns end_turn with no text content at all.
      // This produces a completely blank response in the REPL — no text, no
      // tool calls — making it look like the agent is frozen or the request
      // was silently dropped. Common causes: ambiguous prompts that the model
      // has nothing to say about, context pollution from prior compaction, or
      // the model deciding (correctly or not) that no further action is needed
      // after a tool sequence. Without a warning, the user stares at an empty
      // screen unsure if something went wrong. The check verifies that no text
      // block contains any non-whitespace characters (not just zero text blocks)
      // because the model sometimes emits a text block with whitespace only.
      //
      // Uses `every(d => !hasNonWhitespace(d))` instead of `join("").trim()`
      // to avoid allocating a potentially large intermediate string from all
      // text deltas just to check emptiness. For large responses with many
      // deltas this would create and immediately discard a string proportional
      // to the full response size. The `every()` approach short-circuits on
      // the first delta containing non-whitespace, checking nothing further.
      if (
        result.response.stop_reason === "end_turn" &&
        result.textDeltas.every((d) => !/\S/.test(d))
      ) {
        printWarning(
          "Model returned an empty response (no text output). Try rephrasing your message, " +
          "use /compact to reduce context (in case prior compaction poisoned the history), " +
          "or ask the model to explain what it's thinking."
        );
      }
      // Warn when stop_reason is null/undefined — this is an API anomaly
      // that should never happen in normal operation. Silently defaulting
      // to "end_turn" masks the issue: the model may have been interrupted
      // by an internal error, a networking issue, or a new safety mechanism
      // that the SDK doesn't yet surface. Without a warning, the user sees
      // a normal-looking turn end and has no reason to suspect anything went
      // wrong. The "end_turn" fallback is kept so the loop terminates cleanly,
      // but the warning gives the user a signal to inspect the response.
      if (result.response.stop_reason == null) {
        printWarning(
          "API returned a null stop_reason (unexpected). Treating as end_turn — " +
          "this may indicate an API anomaly, SDK version mismatch, or a transient server issue. " +
          "If this persists, check your Anthropic SDK version or API status."
        );
      }
      yield {
        type: "turn_complete",
        stopReason: result.response.stop_reason ?? "end_turn",
      };

      // ── Eval gate (§15) ──
      // When eval is enabled and the model has completed its work (end_turn),
      // run multi-judge evaluation before accepting the result. If the judges
      // determine the work is incomplete, inject their feedback as a refinement
      // prompt and continue the loop for another pass.
      //
      // Skip eval for:
      //   - Non-end_turn stop reasons (max_tokens, content_filter) — the model
      //     didn't finish normally, so eval would judge incomplete work
      //   - Empty responses — nothing to evaluate
      //   - Sub-agents — handled by effectiveEnableEval (depth > 0 is excluded)
      //   - Beyond MAX_EVAL_ROUNDS — prevent infinite refinement
      if (
        effectiveEnableEval &&
        result.response.stop_reason === "end_turn" &&
        result.textDeltas.some((d) => /\S/.test(d)) &&
        evalRound < MAX_EVAL_ROUNDS
      ) {
        evalRound++;

        yield {
          type: "eval_start",
          round: evalRound,
          judgeCount: DEFAULT_JUDGES.length,
        };

        try {
          const evalResult = await evaluateWork(
            messages,
            context.abortController.signal,
            DEFAULT_JUDGES,
            evalRound
          );

          // Yield individual judge verdicts for UI display
          for (const verdict of evalResult.verdicts) {
            yield {
              type: "eval_judge_verdict",
              verdict: {
                judgeName: verdict.judgeName,
                isComplete: verdict.isComplete,
                reasoning: verdict.reasoning,
              },
              round: evalRound,
            };
          }

          if (evalResult.passedMajority) {
            // Majority of judges agree the work is complete — accept it
            yield {
              type: "eval_complete",
              passed: true,
              round: evalRound,
            };
            return;
          }

          // Eval failed — inject refinement prompt and continue the loop
          yield {
            type: "eval_complete",
            passed: false,
            round: evalRound,
            refinementPrompt: evalResult.refinementPrompt,
          };

          // Inject the refinement feedback as a new user message so the
          // model sees the judges' feedback and can address it
          const refinementMsg = buildRefinementMessage(evalResult);
          messages.push(refinementMsg);

          // Continue the while loop — the model will process the refinement
          // prompt and produce a new response addressing the judges' concerns
          continue;
        } catch (evalErr: unknown) {
          // If eval fails (API error, abort, etc.), log and fall through to
          // normal completion. Eval is a verification layer, not a gate that
          // should block the user from seeing results. Better to deliver
          // unverified results than to crash or hang.
          if (isAbortError(evalErr)) {
            yield { type: "error", error: "Aborted during evaluation" };
            return;
          }
          const msg = evalErr instanceof Error ? evalErr.message : String(evalErr);
          printWarning(`Eval failed (${msg}). Accepting result without evaluation.`);
          return;
        }
      }

      // No eval, or eval not applicable — normal exit
      return;
    }

    // When the model hit max_tokens AND produced tool calls, the response may
    // have been truncated mid-stream — some intended tool calls might not have
    // been emitted, and the model's text narration may be cut off mid-sentence.
    // The agentic loop continues (executing whatever tool calls were complete),
    // but the user sees truncated text with no explanation. Warn so the user
    // knows the response was incomplete and can increase ANTHROPIC_MAX_OUTPUT_TOKENS
    // if this happens frequently. This is distinct from the `turn_complete`
    // warning (line ~565): that fires only when the loop ENDS with stop_reason
    // "max_tokens" (no tool calls → done), while this fires when the loop
    // CONTINUES despite the truncation (tool calls present → keep going).
    if (result.response.stop_reason === "max_tokens") {
      printWarning(
        `Model response was truncated (hit max_tokens limit of ${config.maxOutputTokens.toLocaleString()}) — some tool calls may have been lost. Continuing with ${streamingToolUseBlocks.length} tool call${streamingToolUseBlocks.length === 1 ? "" : "s"} that were completed before truncation.`
      );
    }

    // Warn when content_filter fires mid-response with tool calls present.
    // The tool-free branch (lines ~664-668 above) already handles the case
    // where content_filter stops a text-only response, but when tool_use
    // blocks were emitted before the filter triggered, the code falls through
    // to the tool execution path without any warning. The user sees tools
    // executing normally with no indication that the model's response was
    // filtered — the model may have intended to emit additional tool calls or
    // text that was suppressed, and the executed tools may operate on an
    // incomplete plan. Warn so the user can review the results.
    if (String(result.response.stop_reason) === "content_filter") {
      printWarning(
        "Model response was stopped by content filtering. Some tool calls or text may have been suppressed. " +
        `Continuing with ${streamingToolUseBlocks.length} tool call${streamingToolUseBlocks.length === 1 ? "" : "s"} that were completed before filtering.`
      );
    }

    // ── Tool execution ──
    // Tools have already been added to the executor during streaming via the
    // onToolUse callback (§14.1), and may have already started or even
    // completed executing by this point. The executor was created before the
    // stream started and received addTool() calls as each tool_use content
    // block arrived. All we need to do now is:
    // 1. Yield tool_use UI events for each tool that was added
    // 2. Warn if the cap was exceeded
    // 3. Collect results from the executor (some may already be complete)
    // 4. Handle excess tool calls with synthetic error results
    const toolBlocks = streamingToolUseBlocks;
    const cappedCount = Math.min(toolBlocks.length, MAX_TOOL_CALLS_PER_TURN);

    if (toolBlocks.length > MAX_TOOL_CALLS_PER_TURN) {
      printWarning(
        `Model emitted ${toolBlocks.length} tool calls in a single response — capping at ${MAX_TOOL_CALLS_PER_TURN}. Excess calls will not be executed.`
      );
    }

    // Yield tool_use events for the UI. The executor already has these tools
    // (added during streaming via addTool()), so we don't call addTool() again.
    for (let i = 0; i < cappedCount; i++) {
      // Resolve the tool's canonical name for the UI event. The API may return
      // wrong-cased names like "read" or "BASH" that `findTool()` resolves via
      // case-insensitive fallback. Using the canonical name ensures the REPL
      // displays consistent "⚙ Read" instead of "⚙ read", matching the
      // `tool_result` events which use the executor's normalized `toolName`.
      const canonicalName = findTool(toolBlocks[i].name)?.name ?? toolBlocks[i].name;
      yield {
        type: "tool_use",
        toolName: canonicalName,
        input: toolBlocks[i].input,
      };
    }

    // Collect results from the active executor (which may have been reset
    // during retries — see resetForRetry). Some results may already be
    // available if tools completed during the stream.
    const toolResults: ToolResultBlock[] = [];

    for await (const completed of activeExecutor.getRemainingResults()) {
      const toolResult = completed.result ?? {
        content: `Tool "${completed.toolName}" returned no result.`,
        is_error: true,
      };

      // ── Debug: log tool execution result ──
      debugLogToolExecution({
        toolName: completed.toolName,
        toolId: completed.id,
        input: completed.input,
        result: toolResult,
        durationMs: completed.durationMs,
      });

      yield {
        type: "tool_result",
        toolName: completed.toolName,
        result: toolResult,
        durationMs: completed.durationMs,
      };

      toolResults.push({
        type: "tool_result",
        tool_use_id: completed.id,
        content: toolResult.content,
        is_error: toolResult.is_error,
      });
    }

    // Add synthetic error results for any excess tool calls that were not
    // executed. The API requires every tool_use block in the assistant message
    // to have a corresponding tool_result — omitting these would cause a 400
    // error on the next API call.
    //
    // Include the tool name and call index in each error so the model knows
    // exactly which calls were skipped and can re-issue specific ones. When
    // the model emits 60 tool calls with the first 50 executed and the last
    // 10 skipped, a generic "exceeded limit" message gives no indication of
    // *which* 10 calls to retry — the model often retries all of them
    // (hitting the limit again) or gives up entirely. Including the name
    // (e.g., "Grep #51") lets the model selectively re-issue the important
    // ones in a smaller batch.
    //
    // Yield tool_result events for each skipped tool so the user/UI sees
    // which specific tools were not executed. Previously, skipped tools
    // were added to the conversation context (toolResults array for the API)
    // but never yielded — the REPL showed no output for them, making it
    // look like the model intended fewer tool calls than it actually emitted.
    // The user would only see the printWarning about the cap but not know
    // which individual tools were dropped.
    for (let i = cappedCount; i < toolBlocks.length; i++) {
      const skippedName = findTool(toolBlocks[i].name)?.name ?? toolBlocks[i].name;
      const skippedContent = `Error: ${skippedName} call #${i + 1} skipped — exceeded per-turn limit of ${MAX_TOOL_CALLS_PER_TURN} tool calls. Reduce the number of parallel tool calls in your next response.`;
      const skippedResult = {
        content: skippedContent,
        is_error: true,
      };

      yield {
        type: "tool_result",
        toolName: skippedName,
        result: skippedResult,
        durationMs: 0,
      };

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolBlocks[i].id,
        content: skippedContent,
        is_error: true,
      });
    }

    // Add tool results as a user message
    const userResultMessage: Message = {
      role: "user",
      content: toolResults,
    };
    messages.push(userResultMessage);

    // Continue loop — model will decide whether to call more tools
  }

  // Context-aware hint: sub-agents (depth > 0) don't have a REPL, so
  // suggesting `/compact` would be confusing and unhelpful.
  const hint =
    context.depth > 0
      ? "The sub-agent reached its turn limit. Consider breaking the task into smaller pieces or increasing max_turns."
      : "Try breaking the task into smaller pieces, or use /compact to free up context and continue.";
  yield {
    type: "error",
    error: `Maximum turns (${effectiveMaxTurns}) reached. The model is still calling tools. ${hint}`,
  };
}
