import { getConfig } from "../config/config.js";
import { getClient } from "./client.js";
import { printInfo, printWarning } from "../ui/ui.js";
import { safeTruncate } from "../tools/validate.js";
import {
  hasHttpStatus,
  isAbortError,
  isNonRetryableClientError,
  backoffDelay,
  abortableSleep,
  combineSignals,
  retryReasonFromError,
} from "../utils/retry.js";
import { debugLogCompaction } from "./debug.js";
import type { Message, ContentBlock, ToolUseBlock, ThinkingBlock, RedactedThinkingBlock } from "./types.js";

// ── Compaction retry logic ──

/**
 * Maximum retries for the compaction summarization API call.
 * Fewer retries than the main loop (which uses 3) because compaction
 * has a truncation fallback — we don't want to delay for 15+ seconds
 * retrying when the fallback works fine.
 */
const COMPACTION_MAX_RETRIES = 2;
const COMPACTION_BASE_DELAY_MS = 1500;

/**
 * Simple retry wrapper for the compaction API call.
 * Retries on 429 (rate limit) and 5xx (server errors) only.
 * Does NOT retry on 4xx client errors (bad request, auth, etc.)
 * or on user-initiated aborts.
 *
 * Uses shared retry utilities from retry.ts (hasHttpStatus, isAbortError,
 * backoffDelay, abortableSleep) to avoid duplicating the retry/backoff
 * logic that was previously copy-pasted from loop.ts.
 */
async function compactionCallWithRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= COMPACTION_MAX_RETRIES; attempt++) {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      // Don't retry on abort
      if (isAbortError(err)) {
        throw err;
      }
      // Don't retry on non-retryable client errors (400, 401, 403, 404).
      // Uses the shared isNonRetryableClientError() from retry.ts to ensure
      // the retryable/non-retryable classification stays consistent with
      // the main agentic loop in loop.ts. Previously this was an inline
      // check that duplicated the logic — if isNonRetryableClientError was
      // updated (e.g., adding another retryable 4xx status), this copy
      // would silently diverge.
      if (isNonRetryableClientError(err)) {
        throw err;
      }
      // Out of retries
      if (attempt >= COMPACTION_MAX_RETRIES) {
        throw err;
      }
      // Wait before next attempt (exponential with ±25% jitter: ~1.5s, ~3s).
      // Without jitter, multiple concurrent sessions (e.g., two terminal tabs)
      // hitting a 429 rate limit at the same time would both retry at exactly
      // the same instant, causing a thundering herd that re-triggers the 429.
      const delay = backoffDelay(attempt, COMPACTION_BASE_DELAY_MS);
      // Include the error reason so users can distinguish a rate limit (429,
      // just wait) from a server error (5xx, API issue) or a network error
      // (ECONNRESET, check proxy/VPN). Uses the shared retryReasonFromError()
      // from retry.ts — previously this was an inline reimplementation that
      // diverged from loop.ts's version (missing 529 "API overloaded" and
      // generic 5xx labelling).
      const reason = retryReasonFromError(err);
      printWarning(
        `Compaction API call failed (${reason}). Retrying in ${(delay / 1000).toFixed(1)}s (retry ${attempt + 1}/${COMPACTION_MAX_RETRIES})…`
      );
      await abortableSleep(delay, signal);
    }
  }
  throw lastError ?? new Error("Unexpected: compaction retry loop exhausted");
}

/**
 * Estimate token count from messages (rough approximation: ~4 chars per token).
 *
 * Includes per-message structural overhead: the API adds ~4 tokens per message
 * for role labels, separators, and message framing. Without this, a conversation
 * with 100 small messages (e.g., short tool results) would underestimate by
 * ~400 tokens — not individually significant, but cumulative across long
 * tool-heavy sessions where messages are numerous but individually small.
 *
 * Accepts an optional `systemPromptLength` so callers can account for the
 * system prompt that is sent with every API call. The system prompt typically
 * adds 400–2000 chars (~100–500 tokens) that are invisible to message-only
 * counting. Without it, auto-compaction triggers ~100–500 tokens late, which
 * can cause "context too long" API errors on the borderline.
 */
export function estimateTokens(messages: Message[], systemPromptLength?: number): number {
  // Account for the system prompt if provided. The system prompt is sent
  // with every API call but isn't part of the messages array, so it's
  // systematically missed without this addition.
  let chars = systemPromptLength ?? 0;
  for (const msg of messages) {
    // Per-message overhead: role label ("user"/"assistant"), message delimiters,
    // and structural tokens. ~4 tokens ≈ 16 chars at the 4 chars/token ratio.
    chars += 16;
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        // Guard against null/undefined entries in the content array — restored
        // sessions with corrupt data can produce `content: [null, ...]` where
        // `null.type` throws TypeError, crashing estimateTokens() and breaking
        // auto-compaction, /tokens, /status, and the status bar. The same
        // defensive null-guard pattern is used in `microCompact()`,
        // `sanitizeMessageSlice()`, `summarizeContent()`, and
        // `repairOrphanedToolUse()` for the same reason.
        if (block == null) continue;
        if (block.type === "text") {
          chars += block.text.length;
        } else if (block.type === "tool_result") {
          // Count the tool_use_id field — each UUID is ~36 characters.
          // Without this, token estimates are systematically low in
          // tool-heavy conversations (e.g., 20 tool calls × 36 chars
          // = 720 chars ≈ 180 tokens unaccounted for per round-trip).
          if (typeof block.tool_use_id === "string") {
            chars += block.tool_use_id.length;
          }
          // Count the `is_error` boolean field. When true, the API
          // serializes `"is_error": true` (~15 chars). In tool-heavy
          // sessions with many errors (e.g., repeated failed edits),
          // this adds up: 20 error results × 15 chars = 300 chars
          // ≈ 75 tokens systematically undercounted.
          if (block.is_error) {
            chars += 15;
          }
          if (typeof block.content === "string") {
            chars += block.content.length;
          } else if (Array.isArray(block.content)) {
            for (const sub of block.content) {
              // Guard against non-text sub-blocks (same issue fixed in
              // summarizeContent — restored sessions or future API versions
              // may include non-text entries lacking a `.text` property).
              if (sub != null && typeof sub.text === "string") {
                chars += sub.text.length;
              }
            }
          }
        } else if (block.type === "tool_use") {
          // Guard against undefined/non-string name/id (possible in corrupted
          // restored sessions or future API shape changes). Without these checks,
          // `undefined.length` throws a TypeError that crashes estimateTokens(),
          // breaking auto-compaction, /tokens, /status, and the status bar —
          // cascading into a broken REPL. The block.input guard below was already
          // present, but name/id were unprotected.
          if (typeof block.name === "string") chars += block.name.length;
          if (typeof block.id === "string") chars += block.id.length;
          // Guard against serialization errors — `block.input` could contain
          // circular references from restored sessions with corrupt data, or
          // unexpected non-serializable values.  A crash here would break the
          // auto-compaction check, the /tokens command, and the status bar,
          // cascading into a broken REPL.  Fall back to a conservative estimate
          // (the word "input" as a placeholder) rather than crashing.
          try {
            chars += JSON.stringify(block.input).length;
          } catch {
            chars += 100; // conservative fallback
          }
        } else if (block.type === "thinking") {
          // Extended thinking block — the `thinking` field contains the
          // model's chain-of-thought reasoning text. The `signature` field
          // is also sent to the API and occupies context, but is relatively
          // small (~100 chars). Include it for accuracy.
          //
          // Guard with `typeof` checks: restored sessions with corrupt data
          // could have `thinking: undefined` or `thinking: null`. Without
          // the guard, `undefined.length` throws a TypeError that crashes
          // estimateTokens(), breaking auto-compaction, /tokens, /status,
          // and the status bar — the same cascading failure guarded against
          // in the tool_use branch above for `name` and `id`.
          if (typeof block.thinking === "string") chars += block.thinking.length;
          else chars += 100; // conservative fallback for corrupt data
          if (typeof block.signature === "string") chars += block.signature.length;
        } else if (block.type === "redacted_thinking") {
          // Redacted thinking block — the `data` field is an opaque string
          // (base64-encoded). It still occupies tokens in the context window.
          //
          // Guard with `typeof` check for the same reason as `thinking` above:
          // corrupt restored sessions could have `data: undefined`.
          if (typeof block.data === "string") chars += block.data.length;
          else chars += 100; // conservative fallback for corrupt data
        } else if (block.type === "image") {
          // Image blocks carry base64 data which is large but effectively
          // consumed as a single vision token bucket by the API. Use a
          // conservative fixed estimate (~1000 chars ≈ 250 tokens).
          chars += 1000;
        } else {
          // Handle any future block types defensively. If the ContentBlock
          // union is extended with new types, this branch catches them with
          // a conservative fallback rather than silently ignoring them.
          const _exhaustive: never = block;
          try {
            chars += JSON.stringify(_exhaustive).length;
          } catch {
            chars += 100;
          }
        }
      }
    } else {
      // msg.content is neither string nor array — this can happen with a
      // corrupted restored session (e.g., `content: null`, `content: 42`,
      // or `content: undefined`). Silently ignoring such messages would
      // contribute 0 to the token estimate, potentially delaying
      // auto-compaction and causing "context too long" API errors later.
      // Use a conservative fallback estimate (~25 tokens ≈ 100 chars).
      chars += 100;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Repair orphaned tool_use blocks after an abort or compaction.
 *
 * The Anthropic API requires every tool_use block in an assistant message to
 * have a corresponding tool_result in a subsequent user message. Orphaned
 * tool_use blocks (without matching tool_result) can arise from:
 *
 * 1. **Ctrl+C abort**: The assistant message with tool_use blocks is pushed
 *    to `messages`, but the agentic loop is interrupted before the matching
 *    tool_result user message is added.
 *
 * 2. **Compaction**: The alternation enforcement loop after `sanitizeMessageSlice`
 *    may drop a user tool_result message (because it would create consecutive
 *    same-role entries), leaving the corresponding assistant tool_use in a
 *    non-final position with no matching tool_result.
 *
 * This function scans ALL messages to find tool_use IDs without matching
 * tool_result entries, then appends a single synthetic user message with
 * tool_result entries marked as errors ("Aborted by user") for each orphan.
 * Mutates `messages` in-place.
 */
export function repairOrphanedToolUse(messages: Message[]): void {
  if (messages.length === 0) return;

  // Collect ALL tool_use IDs and tool_result IDs in a single pass over the
  // messages array.  Previously this used two separate full passes — one for
  // tool_use IDs (assistant messages) and one for tool_result IDs (user
  // messages).  Since `msg.role` already discriminates between the two,
  // a single scan collects both sets simultaneously, halving the scan cost
  // for conversations with many messages.
  //
  // Guard with `typeof block.id === "string"` to prevent corrupted session data
  // (e.g., `id: undefined`, `id: null`, `id: 42`) from poisoning the Set.
  // `Set.add(undefined)` succeeds silently, and if a tool_result also has
  // `tool_use_id: undefined`, `Set.has(undefined)` returns true — so the
  // orphan detection would consider the corrupt pair "matched" and skip
  // generating a synthetic repair entry, leaving genuinely orphaned tool_use
  // blocks unrepaired and causing a 400 "missing tool_result" error on the
  // next API call. The same defensive pattern is used in estimateTokens()
  // and summarizeContent() for the same fields.
  //
  // Guard with `block != null` before accessing `block.type`: restored sessions
  // with corrupt data can produce `content: [null, ...]` where `null.type`
  // throws TypeError, crashing the entire repair function. The same defensive
  // null-guard pattern is already used in `microCompact()`, `estimateTokens()`,
  // `sanitizeMessageSlice()`, and the `isToolResultUserMsg`/`isToolUseAssistantMsg`
  // helpers in `autoCompact()`.
  const allToolUseIds = new Set<string>();
  const allToolResultIds = new Set<string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block != null && block.type === "tool_use" && typeof block.id === "string") {
          allToolUseIds.add(block.id);
        }
      }
    } else if (msg.role === "user") {
      for (const block of msg.content) {
        if (block != null && block.type === "tool_result" && typeof block.tool_use_id === "string") {
          allToolResultIds.add(block.tool_use_id);
        }
      }
    }
  }
  if (allToolUseIds.size === 0) return;

  // Find orphaned tool_use IDs (have tool_use but no matching tool_result)
  const orphanedIds: string[] = [];
  for (const id of allToolUseIds) {
    if (!allToolResultIds.has(id)) {
      orphanedIds.push(id);
    }
  }
  if (orphanedIds.length === 0) return;

  // Build synthetic tool_result entries for each orphaned tool_use.
  // Previously this only checked the LAST message, missing orphaned tool_use
  // blocks in non-final assistant messages. This can happen when compaction's
  // alternation enforcement loop drops a user tool_result message (because it
  // would create consecutive same-role entries), leaving the corresponding
  // assistant tool_use in a non-final position with no matching tool_result.
  // The API requires every tool_use to have a tool_result, regardless of
  // position in the conversation.
  const syntheticResults: ContentBlock[] = orphanedIds.map((id) => ({
    type: "tool_result" as const,
    tool_use_id: id,
    content: "Aborted by user.",
    is_error: true,
  }));

  // If the last message is already a user message with array content,
  // merge the synthetic tool_results into it instead of appending a new
  // user message.  Appending a separate user message when the last one
  // is already user-role would create consecutive same-role messages,
  // which violates the API's strict role-alternation requirement and
  // causes a 400 error on the next call.
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
    lastMsg.content.push(...syntheticResults);
  } else if (lastMsg?.role === "user" && typeof lastMsg.content === "string") {
    // The last message is a user message with plain string content (e.g., the
    // user just typed a new prompt). We can't append tool_result blocks to a
    // string, so convert it to an array with both a text block and the synthetic
    // tool_results. This avoids creating consecutive same-role user messages
    // which would violate the API's strict role-alternation requirement.
    lastMsg.content = [
      { type: "text" as const, text: lastMsg.content },
      ...syntheticResults,
    ];
  } else {
    messages.push({
      role: "user",
      content: syntheticResults,
    });
  }
}

/**
 * Micro-compaction: Replace large tool results and tool inputs in-place with
 * truncation notices. Keeps the 3 most recent large tool results intact;
 * older ones above 10 KB are replaced with a brief "[Result truncated]"
 * placeholder. Also truncates large `tool_use` input objects (e.g., Write
 * tool calls with full file content) in all but the 3 most recent, using
 * the same threshold and strategy.
 *
 * Mutates the input array directly — does not return a new array.
 */
export function microCompact(messages: Message[]): void {
  // Collect large tool_result and tool_use blocks in a single pass over the
  // messages array. Previously this used two separate full passes — one for
  // tool_result blocks (user messages) and one for tool_use inputs (assistant
  // messages). Merging them halves the scan cost for tool-heavy conversations
  // (typical: dozens of messages with multiple content blocks each). Each
  // block type is still tracked in its own array because they have
  // independent "keep 3 most recent" thresholds.
  const LARGE_BLOCK_THRESHOLD = 10000;
  const resultIndices: { msgIdx: number; blockIdx: number; size: number }[] = [];
  const inputIndices: { msgIdx: number; blockIdx: number; size: number }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;

    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      // Guard against null/undefined array entries — restored sessions with
      // corrupt data can produce `content: [null, ...]` where `null.type`
      // throws TypeError, crashing the post-turn micro-compaction. The same
      // defensive null-guard pattern is already used in `sanitizeMessageSlice()`,
      // `summarizeContent()`, and the `isToolResultUserMsg`/`isToolUseAssistantMsg`
      // helpers in `autoCompact()`.
      if (block == null) continue;

      if (block.type === "tool_result") {
        let size: number;
        if (typeof block.content === "string") {
          size = block.content.length;
        } else {
          // Guard against serialization errors — block.content could contain
          // circular references from restored sessions with corrupt data.
          // Same guard applied in estimateTokens() and summarizeContent().
          // A crash here would break the post-turn micro-compaction cleanup.
          try {
            size = JSON.stringify(block.content).length;
          } catch {
            size = 100; // conservative fallback
          }
        }
        if (size > LARGE_BLOCK_THRESHOLD) {
          resultIndices.push({ msgIdx: i, blockIdx: j, size });
        }
      } else if (block.type === "tool_use") {
        // Micro-compact large tool_use input objects. The Write tool sends the
        // full file content as `input.content`, and the Edit tool sends
        // `old_string` + `new_string` — these can be thousands of characters.
        // After execution, the model already knows what it wrote/edited (the
        // tool_result confirms success), so keeping the full input wastes tokens.
        let size: number;
        try {
          size = JSON.stringify(block.input).length;
        } catch {
          size = 100;
        }
        if (size > LARGE_BLOCK_THRESHOLD) {
          inputIndices.push({ msgIdx: i, blockIdx: j, size });
        }
      }
    }
  }

  // Keep 3 most recent large results intact, truncate the rest
  const toTruncate = resultIndices.slice(
    0,
    Math.max(0, resultIndices.length - 3)
  );

  for (const { msgIdx, blockIdx, size: originalSize } of toTruncate) {
    const msg = messages[msgIdx];
    if (typeof msg.content === "string") continue;
    const block = msg.content[blockIdx];
    if (block.type === "tool_result") {
      // Preserve the original content type (string vs array-of-text-blocks).
      // The Anthropic API accepts both formats for tool_result content, and
      // downstream code (or restored sessions) may branch on `typeof content`.
      // Previously this always assigned a plain string, silently changing the
      // type from array to string for results that were originally arrays.
      const truncationMsg = `[Result truncated — was ${originalSize} chars. Re-run the tool if needed.]`;
      if (Array.isArray(block.content)) {
        block.content = [{ type: "text" as const, text: truncationMsg }];
      } else {
        block.content = truncationMsg;
      }
    }
  }

  // Keep 3 most recent large inputs intact (the model may need to reference
  // them for follow-up edits), truncate older ones.
  const inputsToTruncate = inputIndices.slice(
    0,
    Math.max(0, inputIndices.length - 3)
  );

  for (const { msgIdx, blockIdx, size: originalSize } of inputsToTruncate) {
    const msg = messages[msgIdx];
    if (typeof msg.content === "string") continue;
    const block = msg.content[blockIdx];
    if (block.type === "tool_use") {
      // Build a compact replacement input that preserves the tool name and
      // key identifying parameters (file_path for Write/Edit, url for WebFetch)
      // while replacing the bulk content with a truncation notice.
      const compactInput: Record<string, unknown> = {};
      const input = block.input;
      // Guard against non-object input values. The TypeScript type says
      // `Record<string, unknown>`, but restored sessions with corrupt data
      // can produce `input: null`, `input: undefined`, or `input: 42`.
      // `Object.keys(null)` throws `TypeError: Cannot convert undefined or
      // null to object`, crashing the entire micro-compaction pass. The
      // JSON.stringify guard above (which determines whether the input
      // exceeds the size threshold) already handles this via try/catch,
      // but if the size estimate falls back to 100 chars and that exceeds
      // the threshold, this code path runs on the corrupt input. The same
      // defensive pattern (null/typeof/Array checks) is already applied in
      // `estimateTokens()`, `summarizeContent()`, and `safeToolInput()`.
      if (input != null && typeof input === "object" && !Array.isArray(input)) {
        // Preserve small identifying parameters
        for (const key of Object.keys(input)) {
          const val = input[key];
          if (typeof val === "string" && val.length <= 500) {
            compactInput[key] = val;
          } else if (typeof val === "boolean" || typeof val === "number") {
            compactInput[key] = val;
          }
          // Large string values (content, old_string, new_string) are omitted
        }
      }
      compactInput._truncated = `[Input truncated — was ${originalSize} chars]`;
      block.input = compactInput;
    }
  }
}

/**
 * Ensure a message slice forms a valid conversation:
 * 1. Must start with a "user" message
 * 2. Roles must strictly alternate (user, assistant, user, assistant, ...)
 * 3. All tool_result blocks must reference tool_use IDs present in preceding
 *    assistant messages (no orphaned tool_result blocks)
 *
 * Messages that violate these constraints are dropped. Returns both the
 * sanitized messages and a count of dropped messages so the caller can
 * log a diagnostic (previously dropped messages were completely silent,
 * making post-compaction confusion impossible to debug).
 */
function sanitizeMessageSlice(messages: Message[]): { sanitized: Message[]; droppedCount: number } {
  const result: Message[] = [];
  let expectedRole: "user" | "assistant" = "user";
  // Track tool_use IDs incrementally to avoid O(n²) re-scanning
  const validToolUseIds = new Set<string>();
  let droppedCount = 0;

  for (const msg of messages) {
    if (msg.role !== expectedRole) {
      droppedCount++;
      continue;
    }

    // For assistant messages, collect tool_use IDs as we go.
    // Guard with `typeof block.id === "string"` to prevent corrupt session
    // data (e.g., `id: undefined`, `id: null`) from poisoning the Set.
    // `Set.add(undefined)` succeeds silently, and if a tool_result also has
    // `tool_use_id: undefined`, `Set.has(undefined)` returns true — so the
    // orphan filter below would consider the corrupt pair "matched" and keep
    // an orphaned tool_result block that should have been stripped, causing
    // a 400 "invalid tool_result" error on the next API call. The same
    // defensive `typeof` pattern is already used in `repairOrphanedToolUse()`
    // (improvement #25) and `estimateTokens()` for the same fields.
    //
    // Guard with `block != null` before accessing `block.type`: restored
    // sessions with corrupt data can produce `content: [null, ...]` where
    // `null.type` throws TypeError, crashing the entire sanitization pass
    // and breaking compaction. The same defensive null-guard pattern is
    // already used in `microCompact()` (line ~342) and `repairOrphanedToolUse()`
    // for the same reason.
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block != null && block.type === "tool_use" && typeof block.id === "string") {
          validToolUseIds.add(block.id);
        }
      }
    }

    // For user messages with tool_result content blocks, filter out any
    // tool_result blocks whose tool_use_id doesn't match an assistant
    // tool_use in the result so far. Same `typeof` guard: a corrupt
    // `tool_use_id: undefined` must not match `Set.has(undefined)` against
    // a legitimately absent key — it should be treated as orphaned and dropped.
    //
    // Same `block != null` guard as the assistant loop above: a null entry
    // in the content array would crash on `block.type` access.
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const filteredContent: ContentBlock[] = [];

      for (const block of msg.content) {
        if (block == null) continue;
        if (block.type === "tool_result") {
          if (typeof block.tool_use_id === "string" && validToolUseIds.has(block.tool_use_id)) {
            filteredContent.push(block);
          }
          // else: orphaned tool_result (or corrupt tool_use_id) — drop it
        } else {
          filteredContent.push(block);
        }
      }

      // If we filtered out all blocks, skip this message entirely.
      // Also skip messages where the only remaining content is empty text
      // blocks — these carry no semantic value and some API versions reject
      // messages with `content: [{ type: "text", text: "" }]`. This can
      // happen when a user message had only orphaned tool_result blocks
      // (all removed above) plus an empty text block (e.g., from
      // repairOrphanedToolUse or a round-trip through the API that
      // normalizes empty strings into text blocks).
      //
      // Guard with `typeof b.text === "string"` before calling `.trim()`:
      // corrupt restored sessions or future API changes could produce a text
      // block with `text: undefined` or `text: null`. Without the guard,
      // `undefined.trim()` throws a TypeError that crashes sanitization,
      // breaking compaction entirely. A text block with non-string text is
      // treated as non-substantive (empty) since it carries no useful content.
      const hasSubstantiveContent = filteredContent.some((b) =>
        b.type !== "text" || (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0)
      );
      if (filteredContent.length === 0 || !hasSubstantiveContent) {
        droppedCount++;
        continue;
      }

      result.push({ role: msg.role, content: filteredContent });
    } else {
      result.push(msg);
    }

    expectedRole = expectedRole === "user" ? "assistant" : "user";
  }

  return { sanitized: result, droppedCount };
}

/**
 * Produce a human-readable summary of a message's content, optimized for
 * the compaction summarizer. Unlike `JSON.stringify`, this strips
 * structural noise (tool_use_ids, type tags) and focuses on semantically
 * meaningful content: text, tool names + key parameters, and truncated
 * tool results.
 */
function summarizeContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;

  // Guard against non-iterable content values. The TypeScript type says
  // `string | ContentBlock[]`, but restored sessions with corrupt data can
  // produce `content: null`, `content: undefined`, or `content: 42`. Without
  // this guard, `for (const block of content)` throws `TypeError: content is
  // not iterable`, crashing the compaction pipeline — which cascades into the
  // context growing unboundedly until hitting the API's token limit. The same
  // defensive pattern is used in `estimateTokens()` (line ~182) which already
  // handles non-string-non-array content with a conservative fallback.
  if (!Array.isArray(content)) return "(corrupt message content)";

  const parts: string[] = [];
  for (const block of content) {
    // Guard against null/undefined entries in the content array — same
    // defensive pattern as microCompact(), sanitizeMessageSlice(), and
    // repairOrphanedToolUse(). A corrupt restored session could produce
    // `content: [null, ...]` where `null.type` throws TypeError.
    if (block == null) continue;
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      // Show tool name + compact input (file paths are the most useful).
      // Guard against serialization errors — block.input could contain
      // circular references from restored sessions (same guard applied in
      // estimateTokens above). A crash here would break the compaction
      // pipeline, causing the context to grow unboundedly.
      const toolName = typeof block.name === "string" ? block.name : "(unknown)";
      let inputStr: string;
      try {
        inputStr = JSON.stringify(block.input);
      } catch {
        inputStr = "(input not serializable)";
      }
      const truncatedInput =
        inputStr.length > 500 ? safeTruncate(inputStr, 500) + "…" : inputStr;
      parts.push(`[Tool: ${toolName}] ${truncatedInput}`);
    } else if (block.type === "tool_result") {
      // Show a truncated tool result, stripping verbose array wrapper.
      // Guard with a type+text check because restored sessions or future
      // API versions might include non-text sub-blocks (e.g., image);
      // accessing `.text` on those would throw a TypeError.
      const resultContent =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter((b): b is { type: "text"; text: string } =>
                  b != null && b.type === "text" && typeof b.text === "string")
                .map((b) => b.text)
                .join("\n")
            : "";
      const errorTag = block.is_error ? " (ERROR)" : "";
      const truncated =
        resultContent.length > 1000
          ? safeTruncate(resultContent, 1000) + "…"
          : resultContent;
      parts.push(`[Result${errorTag}] ${truncated}`);
    } else if (block.type === "thinking") {
      // Extended thinking — include a truncated version so the compaction
      // summary captures the reasoning intent without the full text.
      //
      // Guard with `typeof` check: restored sessions with corrupt data
      // could have `thinking: undefined`. Without the guard,
      // `undefined.length` throws a TypeError that crashes the compaction
      // pipeline, causing the context to grow unboundedly. Same guard
      // pattern applied in estimateTokens() above for the same field.
      if (typeof block.thinking === "string" && block.thinking.length > 0) {
        const truncatedThinking =
          block.thinking.length > 500
            ? safeTruncate(block.thinking, 500) + "…"
            : block.thinking;
        parts.push(`[thinking] ${truncatedThinking}`);
      } else {
        parts.push(`[thinking]`);
      }
    } else if (block.type === "redacted_thinking") {
      // Redacted thinking — no useful text to include, just note its presence.
      parts.push(`[redacted_thinking]`);
    } else if (block.type === "image") {
      // Image blocks — note the presence but don't dump raw base64 data.
      parts.push(`[image: ${block.source.media_type}]`);
    } else {
      // Future block types — include raw content if possible.
      // Mirror the approach in estimateTokens() which uses JSON.stringify
      // as a fallback for unknown block types. Without this, new block types
      // added to the ContentBlock union would be silently dropped from
      // compaction summaries — their content would vanish after compaction,
      // losing potentially important conversation context. Including the raw
      // JSON ensures at least some representation survives.
      const _exhaustive: never = block;
      try {
        const raw = JSON.stringify(_exhaustive);
        // Cap the raw JSON to prevent a single huge unknown block (e.g., a
        // future "attachment" block with inline binary data) from dominating
        // the summary and squeezing out actual conversation content.
        if (raw && raw.length > 0) {
          parts.push(raw.length > 500 ? safeTruncate(raw, 500) + "…" : raw);
        }
      } catch {
        // JSON.stringify can throw on circular references or BigInt values.
        // Fall through — losing one unknown block is better than crashing.
      }
    }
  }
  return parts.join("\n");
}

/**
 * Auto-compaction: When context gets too large, summarize the conversation
 * and replace most messages with the summary.
 *
 * Accepts an optional AbortSignal so the compaction API call can be
 * cancelled (e.g., when the user presses Ctrl+C).
 */
export async function autoCompact(
  messages: Message[],
  systemPrompt: string,
  signal?: AbortSignal,
  force?: boolean
): Promise<Message[]> {
  const config = getConfig();
  const tokens = estimateTokens(messages, systemPrompt.length);

  if (!force && tokens < config.compactionThreshold) {
    return messages;
  }

  // Don't compact if there are too few messages — there's nothing meaningful
  // to summarize, and the summary + acknowledgment combo (2 messages) would
  // not save any space.
  if (messages.length <= 4) {
    // Only warn when this is an auto-compaction (tokens over threshold, not
    // user-forced). The /compact command handler has its own feedback for
    // this case — printing a warning here too would double-message the user.
    if (!force && tokens >= config.compactionThreshold) {
      printWarning(
        "Too few messages to compact (need more than 4). The context is large due to individual message size, not message count. Try using shorter tool outputs or clearing the conversation with /clear."
      );
    }
    return messages;
  }

  printInfo(
    force && tokens < config.compactionThreshold
      ? `Force-compacting with ${config.smallModel}: ~${tokens.toLocaleString()} tokens (below threshold of ${config.compactionThreshold.toLocaleString()})`
      : `Compacting with ${config.smallModel}: ~${tokens.toLocaleString()} tokens exceeds threshold of ${config.compactionThreshold.toLocaleString()}`
  );

  // Build summary request
  const client = getClient();

  try {
    // Build the conversation text for summarization.  Each message is
    // truncated to 5000 chars, but with 100+ messages this can still
    // produce a prompt that exceeds the smallModel's context window.
    // Cap the total at ~120K chars (~30K tokens at 4 chars/token) and
    // reserve 4K tokens for the summary output, staying well within
    // typical 32K–128K context windows.
    const MAX_SUMMARY_INPUT_CHARS = 120_000;

    // Summarize messages lazily — only compute the summary string for
    // messages that will actually be included in the prompt. Previously,
    // `messages.map(…)` eagerly computed summaries for ALL messages, then
    // the budget-trimming code below discarded the middle ~40%. For a
    // 200-message conversation, this wasted ~80 `summarizeContent()` +
    // `safeTruncate()` calls (each involving JSON.stringify on tool inputs,
    // string concatenation, and truncation) and allocated ~80 intermediate
    // strings that were immediately garbage-collected.
    const summarizeMessage = (m: Message): string => {
      const content = summarizeContent(m.content);
      return `[${m.role}]: ${safeTruncate(content, 5000)}`;
    };

    // First pass: compute a cheap size estimate for each message to decide
    // which ones will be included, without computing the full summary.
    // Estimate size using raw content length (capped to 5002 for the role
    // prefix + truncation limit). This avoids the expensive summarizeContent()
    // call for messages that will be dropped from the middle.
    const estimateEntryLen = (m: Message): number => {
      let rawLen: number;
      if (typeof m.content === "string") {
        rawLen = m.content.length;
      } else if (Array.isArray(m.content)) {
        // Rough estimate: sum text lengths + 50 per non-text block.
        // Guard `block.text` with a typeof check: restored sessions with
        // corrupt data could produce a text block with `text: undefined` or
        // `text: null`. Without the guard, `undefined.length` throws a
        // TypeError that crashes `estimateEntryLen`, which crashes the
        // `estimatedTotal` loop, which crashes the entire `autoCompact`
        // function — falling through to the catch block's truncation
        // fallback and potentially losing context that a successful
        // summarization would have preserved. The same defensive pattern
        // is already used in `sanitizeMessageSlice` (line ~428) and
        // `estimateTokens` (line ~159) for the same field.
        rawLen = 0;
        for (const block of m.content) {
          // Guard against null/undefined entries in content arrays — same
          // defensive pattern used in estimateTokens(), microCompact(),
          // sanitizeMessageSlice(), summarizeContent(), and
          // repairOrphanedToolUse(). Without this, a corrupt restored session
          // with `content: [null, ...]` crashes on `null.type`, which crashes
          // estimateEntryLen → estimatedTotal loop → autoCompact, falling to
          // the truncation fallback and potentially losing context.
          if (block == null) continue;
          if (block.type === "text" && typeof block.text === "string") rawLen += block.text.length;
          else rawLen += 50;
        }
      } else {
        rawLen = 100;
      }
      // After summarizeContent + safeTruncate(5000), max len is ~5014
      // (role prefix "[user]: " = 8-14 chars + 5000 content)
      return Math.min(rawLen + 14, 5014) + 2; // +2 for "\n\n" separator
    };

    // Check if we need to trim the middle (quick total estimate)
    let estimatedTotal = 0;
    for (const m of messages) {
      estimatedTotal += estimateEntryLen(m);
    }

    let conversationText: string;
    if (estimatedTotal <= MAX_SUMMARY_INPUT_CHARS) {
      // Everything fits — summarize all messages
      const messageSummaries = messages.map(summarizeMessage);
      conversationText = messageSummaries.join("\n\n");
      // Double-check with real lengths (estimates may undershoot for
      // tool_use blocks with large JSON inputs)
      if (conversationText.length > MAX_SUMMARY_INPUT_CHARS) {
        // Fall through to the budget-trimming path below
        conversationText = "";
      }
    } else {
      conversationText = "";
    }

    if (conversationText === "") {
      // If total exceeds budget, keep the first few and last few messages
      // (most important context is at the beginning and end of conversations),
      // dropping middle messages with a placeholder.
      //
      // Strategy: keep first 20% and last 40% of budget, drop middle.
      // Only summarize the head and tail messages that will actually be used.
      const headBudget = Math.floor(MAX_SUMMARY_INPUT_CHARS * 0.2);
      const tailBudget = Math.floor(MAX_SUMMARY_INPUT_CHARS * 0.4);

      // Determine head extent using cheap estimates
      let headChars = 0;
      let headEnd = 0;
      for (let i = 0; i < messages.length; i++) {
        const entryLen = estimateEntryLen(messages[i]);
        if (headChars + entryLen > headBudget) break;
        headChars += entryLen;
        headEnd = i + 1;
      }

      // Determine tail extent using cheap estimates
      let tailChars = 0;
      let tailStart = messages.length;
      for (let i = messages.length - 1; i >= headEnd; i--) {
        const entryLen = estimateEntryLen(messages[i]);
        if (tailChars + entryLen > tailBudget) break;
        tailChars += entryLen;
        tailStart = i;
      }

      // Now compute actual summaries only for head and tail messages
      const headSummaries = messages.slice(0, headEnd).map(summarizeMessage);
      const tailSummaries = messages.slice(tailStart).map(summarizeMessage);

      const droppedCount = tailStart - headEnd;
      const headPart = headSummaries.join("\n\n");
      const tailPart = tailSummaries.join("\n\n");
      conversationText = `${headPart}\n\n[... ${droppedCount} messages omitted for brevity ...]\n\n${tailPart}`;
    }

    const createParams = {
      model: config.smallModel,
      max_tokens: 4096,
      system:
        "Summarize the following conversation between a user and an AI assistant. " +
        "Preserve all important context needed to continue the work:\n" +
        "- Exact file paths (e.g., src/utils/parser.ts, not 'the parser file')\n" +
        "- Exact function, variable, class, and type names verbatim (e.g., handleUserInput, not 'the input handler')\n" +
        "- Code changes made: what was added, modified, or deleted, and in which files\n" +
        "- The chronological order of operations (which files were read/edited first, second, etc.) — this matters for understanding the current state when earlier edits affect later ones\n" +
        "- Line numbers referenced in edits or read operations (e.g., 'edited lines 42-58 of src/app.ts') — these help resume editing without re-reading the file\n" +
        "- Errors encountered and how they were resolved\n" +
        "- Key decisions and their rationale\n" +
        "- The current task and next steps\n" +
        "Do NOT paraphrase identifiers or paths — use the exact names from the conversation. " +
        "Keep the summary concise — aim for roughly 500–1500 words (shorter for brief conversations, longer for extensive ones). " +
        "The summary will replace the conversation history, so it must be substantially shorter than the original while preserving essential context.",
      messages: [
        {
          role: "user" as const,
          content: conversationText,
        },
      ],
    };
    // Pass abort signal so the user can cancel compaction with Ctrl+C
    // instead of waiting for the full API call to complete.
    // Also combine with a 60-second timeout as a safety net: if the
    // smallModel is slow or the network connection hangs, compaction would
    // block indefinitely (or until the user presses Ctrl+C) without this.
    // AbortSignal.any() fires when *either* signal triggers — the user's
    // Ctrl+C signal OR the 60s timeout — whichever comes first.
    // Uses combineSignals() for compatibility with Node.js < 20.3.0
    // where AbortSignal.any() is not available.
    const compactionSignal = signal
      ? combineSignals([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    // Wrap the API call in a retry loop to handle transient 429/5xx errors.
    // Previously, a single transient failure would fall through to the
    // truncation fallback, potentially losing context that a retry would
    // have preserved. The retry logic uses fewer attempts (2) and shorter
    // delays than the main agentic loop since the truncation fallback
    // provides a safety net.

    // ── Debug: log compaction request ──
    debugLogCompaction({
      phase: "request",
      model: config.smallModel,
      messageCount: messages.length,
      messages: createParams.messages,
      tokensBefore: tokens,
    });

    const compactionStart = performance.now();
    const summaryResponse = await compactionCallWithRetry(
      () => client.messages.create(createParams, { signal: compactionSignal }),
      compactionSignal
    );
    const compactionDurationMs = performance.now() - compactionStart;

    // Extract the first text block from the response. Previously this assumed
    // `content[0]` was a text block, but when using extended thinking models
    // the first block may be a `thinking` block (chain-of-thought reasoning)
    // with the actual summary text in a subsequent `text` block. Searching
    // for the first `text` block with non-empty content ensures compatibility
    // with both standard and extended thinking model responses.
    let summaryText = "";
    // Guard with `?? []` in case the API returns null/undefined content —
    // matching the same defensive pattern used in loop.ts (line ~536) and
    // the non-streaming fallback (line ~245). Without this, a proxy or
    // future API version returning null content would crash with
    // `TypeError: summaryResponse.content is not iterable`, producing a
    // misleading "Compaction failed" error. The `?? []` ensures the loop
    // is simply skipped, and the `!summaryText` check below throws a
    // clear "empty or non-text summary response" error instead.
    for (const block of summaryResponse.content ?? []) {
      if (block.type === "text" && block.text.trim().length > 0) {
        summaryText = block.text;
        break;
      }
    }

    // If the API returned no usable text (empty response, non-text content,
    // or other unexpected shape), fall through to the catch block's truncation
    // fallback rather than replacing the entire conversation with a useless
    // "summary generation failed" placeholder — that would catastrophically
    // lose all prior context (file paths, decisions, code changes).
    if (!summaryText) {
      throw new Error(
        "API returned empty or non-text summary response"
      );
    }

    // ── Debug: log compaction response ──
    debugLogCompaction({
      phase: "response",
      model: config.smallModel,
      summary: summaryText,
      tokensBefore: tokens,
      durationMs: compactionDurationMs,
    });

    // Replace all messages with a summary + keep recent messages.
    // We must ensure the final message sequence has valid alternating roles
    // (user, assistant, user, assistant, ...) as required by the Anthropic API.
    // We also need to sanitize the trailing messages to remove orphaned
    // tool_result blocks whose corresponding tool_use IDs are no longer
    // present (they were in the summarized portion of the conversation).
    //
    // Keep up to 6 trailing messages (previously 2). With only 2, the user's
    // most recent question is frequently lost: a single tool-use turn produces
    // user(question) → assistant(tool_use) → user(tool_result) → assistant(answer),
    // so the last 2 messages are just the answer and tool_result — the original
    // question that motivated them is gone. 6 messages covers a typical
    // question + tool-call + answer cycle with room for one additional exchange.
    // Cap at half the total to avoid keeping everything in short conversations.
    //
    // IMPORTANT: Find a clean split boundary that doesn't cut between an
    // assistant tool_use message and its user tool_result message. An arbitrary
    // slice at index N could land right on a user message with tool_result
    // blocks whose corresponding tool_use IDs are in the preceding assistant
    // message (which would be summarized away). sanitizeMessageSlice would
    // strip the orphaned tool_result blocks, silently losing the tool
    // execution results.
    const targetCount = Math.min(6, Math.floor(messages.length / 2));
    const initialSplitIdx = messages.length - targetCount;

    // Helper: returns true if the message at `idx` is a user message containing
    // tool_result blocks (i.e., a bad split point that would orphan those results).
    //
    // Guard with `b != null` before accessing `b.type`: restored sessions with
    // corrupt data can produce `content: [null, ...]` where `null.type` throws
    // TypeError, crashing the entire compaction pipeline. The same defensive
    // null-guard pattern is already used in `extractPreview()`, `summarizeContent()`,
    // `estimateTokens()`, and `sanitizeMessageSlice()` for the same reason.
    const isToolResultUserMsg = (idx: number): boolean => {
      if (idx < 0 || idx >= messages.length) return false;
      const msg = messages[idx];
      return (
        msg.role === "user" &&
        Array.isArray(msg.content) &&
        msg.content.some((b) => b != null && b.type === "tool_result")
      );
    };

    // Helper: returns true if the message at `idx` is an assistant message
    // containing tool_use blocks. Splitting here is also invalid: the
    // compacted base ends with "assistant", so `sanitizeMessageSlice` expects
    // the trailing slice to start with "user" — the leading assistant message
    // would be dropped by role alternation enforcement, orphaning the user
    // tool_result message that follows it (whose tool_use IDs reference the
    // dropped assistant's blocks).
    //
    // Same `b != null` guard as `isToolResultUserMsg` above.
    const isToolUseAssistantMsg = (idx: number): boolean => {
      if (idx < 0 || idx >= messages.length) return false;
      const msg = messages[idx];
      return (
        msg.role === "assistant" &&
        Array.isArray(msg.content) &&
        msg.content.some((b) => b != null && b.type === "tool_use")
      );
    };

    // A "bad boundary" is any position where splitting would break a
    // tool_use/tool_result pair — either because we land ON the tool_result
    // (orphaning it from its tool_use in the summarized portion) or ON the
    // assistant tool_use (which gets dropped by sanitization, orphaning the
    // tool_result that follows).
    const isBadBoundary = (idx: number): boolean => {
      return isToolResultUserMsg(idx) || isToolUseAssistantMsg(idx);
    };

    // Strategy: try adjusting BACKWARD first (keeping more trailing messages,
    // including the assistant tool_use that pairs with the tool_result at the
    // split point). This preserves more recent context. Only if backward
    // adjustment isn't possible (splitIdx would go below 2, leaving too few
    // messages for summarization), fall back to adjusting forward.
    //
    // Cap each direction's search to avoid degeneracy: at most half the target
    // count in either direction.
    let splitIdx = initialSplitIdx;
    const maxAdjust = Math.max(2, Math.floor(targetCount / 2));

    if (isBadBoundary(splitIdx)) {
      // Try backward first: move splitIdx earlier to include complete tool_use/
      // tool_result pair(s). This keeps more context.
      let backIdx = splitIdx;
      let backSteps = 0;
      // Use `>= 1` (not `> 1`) because index 1 is a valid split point:
      // it leaves message[0] for summarization and keeps messages[1..end]
      // as trailing context. The previous `> 1` guard skipped index 1,
      // meaning that when all positions down to index 2 were bad boundaries
      // but index 1 was clean, the backward search unnecessarily gave up
      // and fell through to the forward search — which keeps FEWER trailing
      // messages (worse for context preservation).
      while (backIdx >= 1 && backSteps < maxAdjust && isBadBoundary(backIdx)) {
        backIdx--;
        backSteps++;
      }

      if (!isBadBoundary(backIdx) && backIdx >= 1) {
        // Found a clean split point going backward — use it (keeps more context).
        splitIdx = backIdx;
      } else {
        // Backward didn't work (would eat too far into the conversation or hit
        // the beginning). Fall back to adjusting forward (keeping fewer messages).
        let fwdIdx = splitIdx;
        let fwdSteps = 0;
        while (fwdIdx < messages.length && fwdSteps < maxAdjust) {
          if (isBadBoundary(fwdIdx)) {
            fwdIdx++;
            fwdSteps++;
          } else {
            break;
          }
        }
        // If the forward search also failed to find a clean boundary (exhausted
        // maxAdjust steps while every position was a bad boundary), fall back to
        // the initial split point. sanitizeMessageSlice will strip orphaned
        // tool_result blocks, which is lossy but still correct — better than
        // silently using a bad boundary that we know will cause orphaned blocks.
        // Log a diagnostic so the user knows context was lost.
        if (isBadBoundary(fwdIdx) && fwdIdx < messages.length) {
          printWarning(
            "Could not find a clean compaction boundary — some tool results may be lost from the trailing context."
          );
          splitIdx = initialSplitIdx;
        } else {
          splitIdx = fwdIdx;
        }
      }
    }

    // Safety: if splitIdx advanced past all messages (pathological case where
    // every trailing message is a tool_result user message), fall back to
    // keeping at least the last 2 messages. Without this guard,
    // messages.slice(splitIdx) would be empty, and the compacted result would
    // contain only the summary + acknowledgment with zero trailing context,
    // losing the most recent exchange entirely.
    if (splitIdx >= messages.length) {
      splitIdx = Math.max(0, messages.length - 2);
    }

    const lastMessages = messages.slice(splitIdx);

    // Build the base: summary user message + assistant acknowledgment
    const compactedMessages: Message[] = [
      {
        role: "user",
        content: `[Previous conversation summary]\n${summaryText}\n\n[End of summary — the conversation continues below]`,
      },
      {
        role: "assistant",
        content:
          "I understand the context from the summary. Let me continue where we left off.",
      },
    ];

    // Sanitize lastMessages: strip orphaned tool_result blocks whose
    // tool_use IDs only exist in the summarized (discarded) messages,
    // then enforce role alternation.
    const { sanitized, droppedCount } = sanitizeMessageSlice(lastMessages);

    // Log a diagnostic if messages were dropped during sanitization.
    // Previously this was completely silent, making it impossible to debug
    // why compaction produced confusing results (e.g., lost recent context).
    if (droppedCount > 0) {
      printWarning(
        `Sanitization dropped ${droppedCount} trailing message${droppedCount === 1 ? "" : "s"} (role alternation or orphaned tool results).`
      );
    }

    // Append sanitized messages, but skip any that would violate role
    // alternation. The compacted base ends with role "assistant", so the
    // next message must be "user".
    //
    // If `sanitized` is empty (all trailing messages were dropped because
    // none started with "user", or all content was orphaned tool_results),
    // the compacted result contains only the summary + acknowledgment —
    // which is valid and preserves context. The fallback path (catch block)
    // already guards against empty sanitization, but the happy path didn't,
    // which could produce a confusing "0 messages" compaction result with
    // no recent context. Log a notice so the user knows recent turns were
    // absorbed into the summary.
    if (sanitized.length === 0) {
      printWarning(
        "All recent messages were absorbed into the summary (no trailing messages survived sanitization)."
      );
    }
    let expectedRole: "user" | "assistant" = "user";
    let roleAlternationDrops = 0;
    for (const msg of sanitized) {
      if (msg.role === expectedRole) {
        compactedMessages.push(msg);
        expectedRole = expectedRole === "user" ? "assistant" : "user";
      } else {
        // Skip messages that would create consecutive same-role entries
        roleAlternationDrops++;
      }
    }
    if (roleAlternationDrops > 0) {
      printWarning(
        `Dropped ${roleAlternationDrops} message${roleAlternationDrops > 1 ? "s" : ""} to enforce role alternation after compaction.`
      );
    }

    const newTokens = estimateTokens(compactedMessages, systemPrompt.length);
    const saved = tokens - newTokens;
    const savingsPercent = tokens > 0 ? Math.round((saved / tokens) * 100) : 0;
    printInfo(
      `Compacted: ${messages.length} → ${compactedMessages.length} messages, ~${tokens.toLocaleString()} → ~${newTokens.toLocaleString()} tokens (saved ~${saved.toLocaleString()} tokens, ${savingsPercent}%)`
    );

    // Guard against compaction loops: if the summary is verbose and compaction
    // saved less than 10% of tokens, the compacted result is nearly as large
    // as the original. The next turn will add a few hundred tokens (the new
    // message + response), pushing the total back over the threshold, which
    // triggers auto-compaction again — but the summary will be similarly
    // verbose, creating an infinite compaction cycle on every turn. This wastes
    // API credits on repeated summarization calls and confuses the user with
    // "Auto-compacting…" on every prompt.
    //
    // When savings are insufficient AND the new token count still exceeds the
    // threshold, warn the user and return the ORIGINAL messages. The context
    // will grow until the API rejects it with "context too long", but that's
    // a clear signal to /clear — better than silently burning credits on
    // ineffective compaction every turn. Force-compacted (/compact) calls
    // always accept the result since the user explicitly requested it.
    if (!force && savingsPercent < 10 && newTokens >= config.compactionThreshold) {
      printWarning(
        `Compaction saved only ${savingsPercent}% — the summary is nearly as large as the original. ` +
        `Skipping to avoid a compaction loop. Use /clear to reset the conversation, or ` +
        `/compact to force compaction.`
      );
      return messages;
    }

    return compactedMessages;
  } catch (err: unknown) {
    // Distinguish timeout errors from other failures so the user knows
    // why compaction failed.  `AbortSignal.timeout()` throws a
    // DOMException with name "TimeoutError"; the user's Ctrl+C throws
    // "AbortError".  Without this distinction, the user just sees
    // "Compaction failed: The operation was aborted" with no indication
    // whether it was a network hang, a slow model, or user-initiated.
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    const isUserAbort = err instanceof DOMException && err.name === "AbortError";
    if (isTimeout) {
      printWarning(
        "Compaction timed out after 60 seconds — the summarization model may be overloaded. Falling back to truncation."
      );
    } else if (isUserAbort) {
      printWarning("Compaction cancelled. Falling back to truncation.");
    } else {
      printWarning(
        `Compaction failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Fall back to simple truncation, but sanitize to ensure a valid message
    // sequence (no orphaned tool_result blocks, correct role alternation).
    //
    // Start with the last 20 messages, then progressively trim if the result
    // still exceeds the compaction threshold. The hard-coded 20 could contain
    // a few enormous messages (e.g., a tool result with a 500K-char file dump)
    // that together exceed the model's context window — the API would reject
    // the fallback with "context too long", leaving the user with no recourse
    // except /clear. By checking size and reducing, we ensure the fallback
    // actually fits within the context budget.
    let fallbackSlice = messages.slice(-20);
    let fallbackTokens = estimateTokens(fallbackSlice, systemPrompt.length);
    const fallbackThreshold = config.compactionThreshold;
    while (fallbackSlice.length > 4 && fallbackTokens > fallbackThreshold) {
      // Drop messages from the front to reduce size. Previously this always
      // dropped 2 at a time, assuming each pair was a user/assistant exchange.
      // But after a previous iteration's `slice(2)` or the initial `slice(-20)`,
      // the first message might be "assistant" — dropping 2 then removes
      // [assistant, user], and the remaining slice STILL starts with "assistant".
      // `sanitizeMessageSlice` would then drop that leading assistant message,
      // losing an extra exchange's worth of context unnecessarily.
      //
      // Fix: if the first message is "user", drop 2 (one exchange). If it's
      // "assistant", drop 1 (the orphaned assistant) to re-align on a "user"
      // boundary. This ensures the slice always starts with "user" after each
      // trim, minimizing unnecessary drops by sanitizeMessageSlice.
      const dropCount = fallbackSlice[0]?.role === "user" ? 2 : 1;
      fallbackSlice = fallbackSlice.slice(dropCount);
      fallbackTokens = estimateTokens(fallbackSlice, systemPrompt.length);
    }
    // Warn when the trimming loop exhausted its budget (length <= 4) but the
    // remaining messages still exceed the compaction threshold. This happens
    // when individual messages are very large (e.g., a tool result containing
    // a 500K-char file dump, or a massive Bash output). The next API call will
    // likely fail with "context too long", but without this warning the user
    // has no idea why — the compaction appeared to "succeed" (it returned
    // messages without error). The warning tells the user to /clear, which is
    // the only remaining option when even 4 messages exceed the context budget.
    if (fallbackTokens > fallbackThreshold) {
      printWarning(
        `Fallback truncation still exceeds token threshold (~${fallbackTokens.toLocaleString()} tokens > ${fallbackThreshold.toLocaleString()}). ` +
        `Individual messages are too large to fit within the context budget. ` +
        `The next API call may fail — use /clear to reset the conversation.`
      );
    }
    const { sanitized: fallback, droppedCount: fallbackDropped } = sanitizeMessageSlice(fallbackSlice);
    if (fallbackDropped > 0) {
      printWarning(
        `Fallback sanitization dropped ${fallbackDropped} message${fallbackDropped === 1 ? "" : "s"} (role alternation or orphaned tool results).`
      );
    }
    // If sanitization dropped all messages (e.g., none started with "user"),
    // return a minimal valid conversation so the API call doesn't fail with
    // an "empty messages" error.
    if (fallback.length === 0) {
      printWarning(
        "Fallback truncation produced no valid messages — resetting to summary placeholder."
      );
      return [
        {
          role: "user" as const,
          content: "[Previous conversation was lost due to a compaction error. Please ask the user what they would like to do next.]",
        },
      ];
    }
    // When the fallback retained some messages but earlier conversation
    // history was dropped (which is almost always the case — we're keeping
    // the last ~20 out of potentially hundreds of messages), prepend a
    // context-loss signal. Without this, the model has no indication that
    // prior context is missing and may hallucinate file states, decisions,
    // or prior edits from context that no longer exists. The signal is only
    // added when at least 2 messages were dropped (i.e., meaningful history
    // was lost, not just a leading orphan).
    const totalDropped = messages.length - fallback.length;
    if (totalDropped >= 2 && fallback.length >= 2 && fallback[0]?.role === "user") {
      const lossNote = `[Note: Earlier conversation history (${totalDropped} messages) was lost due to a compaction error. The following messages are the most recent context that was preserved. If you need information from the earlier conversation, ask the user or re-read relevant files.]`;
      const originalContent = fallback[0].content;
      // Preserve the content's structural type: if it's an array of content
      // blocks (e.g., tool_result blocks with tool_use_id references), prepend
      // a text block to the array. Previously this branch used
      // `JSON.stringify(content)` which irreversibly flattened structured content
      // into a JSON string — destroying tool_result/tool_use block semantics.
      // The API would then see the stringified JSON as raw text (not as proper
      // tool_result blocks), breaking the tool_use/tool_result pairing constraint
      // and potentially causing a 400 error on the next API call.
      if (typeof originalContent === "string") {
        fallback[0] = {
          ...fallback[0],
          content: `${lossNote}\n\n${originalContent}`,
        };
      } else if (Array.isArray(originalContent)) {
        fallback[0] = {
          ...fallback[0],
          content: [
            { type: "text" as const, text: lossNote },
            ...originalContent,
          ],
        };
      } else {
        // Corrupt content (null, undefined, number, etc.) — replace entirely
        // with the loss note as a plain string. This is the last resort; the
        // message's content is already unusable.
        fallback[0] = {
          ...fallback[0],
          content: lossNote,
        };
      }
    }
    return fallback;
  }
}
