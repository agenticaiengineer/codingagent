import type {
  Tool,
  ToolContext,
  ToolExecution,
  ToolResult,
  ToolUseBlock,
} from "./types.js";
import { findTool } from "../tools/index.js";
import { printWarning } from "../ui/ui.js";
import { safeTruncate } from "../tools/validate.js";
import { extractCacheMetadata, extractModifiedPaths } from "../utils/explore-cache.js";

/**
 * StreamingToolExecutor — the core parallel tool execution engine.
 *
 * Tools are added as the API streams tool_use blocks. Concurrency-safe tools
 * (Read, Glob, Grep, WebFetch) execute in parallel. Unsafe tools (Write, Edit,
 * Bash) act as barriers — they block until all prior tools finish, execute
 * alone, then release the queue.
 *
 * A maximum parallelism cap (`MAX_CONCURRENT_SAFE`) prevents resource exhaustion
 * when the model emits many concurrent-safe tool calls at once (e.g., 20 parallel
 * file reads could exhaust file descriptors or cause excessive memory pressure).
 */

/**
 * Maximum number of concurrency-safe tools that may execute simultaneously.
 * Prevents file descriptor exhaustion and excessive memory use when the model
 * emits many parallel Read/Glob/Grep/WebFetch calls in a single turn.
 * 8 is high enough for practical parallelism while staying well below typical
 * fd limits (1024 on Linux, ~256 on macOS per process).
 */
const MAX_CONCURRENT_SAFE = 8;

export class StreamingToolExecutor {
  private queue: ToolExecution[] = [];
  private activeCount = 0;
  /** Set of tool_use IDs already added to prevent duplicate execution. Stream
   *  retries or API bugs could re-emit the same tool_use block, causing the
   *  tool to run twice — potentially double-writing a file or executing a
   *  command twice. The set provides O(1) dedup checks on each `addTool`. */
  private seenIds = new Set<string>();
  /** Number of tools still queued (not yet started). Maintained as a counter
   *  so `pendingCount` is O(1) instead of scanning the entire queue. */
  private queuedCount = 0;
  /** Number of currently executing concurrency-unsafe tools (Write, Edit, Bash).
   *  Maintained as a counter to avoid scanning the queue with `Array.some()` on
   *  every `canExecuteTool()` call — previously the `hasActiveUnsafe` check was
   *  O(n) per candidate, making `processQueue()` O(n²) in the number of queued tools. */
  private unsafeActiveCount = 0;
  /** Index of the first item in `this.queue` that is still in "queued" state.
   *  `processQueue()` starts its scan from here, skipping all items that have
   *  already transitioned to "executing"/"completed"/"yielded". Without this,
   *  `processQueue()` scans from index 0 on every invocation — including all
   *  completed items (which are never removed from the queue). For tool-heavy
   *  turns with dozens of sequential tool calls, this causes O(n²) total work
   *  across all `processQueue()` invocations. */
  private nextQueuedIndex = 0;
  /** Completed tool executions awaiting yield by `getRemainingResults()`.
   *  Typed as `(ToolExecution | null)[]` because yielded entries are nulled
   *  out to release memory immediately (tool result strings, input objects)
   *  rather than holding them until the bulk clear at the end. The index
   *  cursor (`completedIdx`) ensures nulled slots are never re-read. */
  private completedQueue: (ToolExecution | null)[] = [];
  /** Index of the first un-yielded item in `completedQueue`. Using an index
   *  cursor instead of `Array.shift()` avoids O(n) re-indexing on each
   *  dequeue, making the drain loop in `getRemainingResults()` O(n) total
   *  instead of O(n²). The array is bulk-cleared after each drain pass. */
  private completedIdx = 0;
  private context: ToolContext;
  /** The set of tools available to this executor's context. Used to list valid
   *  tool names in the error message when the model hallucates an unknown tool.
   *  Previously this used `getAllTools()` which lists ALL registered tools, but
   *  sub-agents only have access to a subset (e.g., Explore agents only have
   *  Read/Glob/Grep). Listing all 9 tools for an Explore agent is misleading —
   *  the model would see Write, Edit, Bash, etc. as "available" and retry with
   *  those names, getting the same "Unknown tool" error again. */
  private availableTools: readonly Tool[];
  private resolveWaiter: (() => void) | null = null;
  /**
   * Set to true when a tool execution errors during parallel execution (§5.5).
   * Once set, all sibling tools that haven't started yet receive a synthetic
   * error instead of executing. This prevents cascading failures: if one tool
   * in a batch fails (e.g., a Read on a non-existent file), starting the
   * remaining tools is pointless since the model will need to re-plan anyway.
   *
   * Exception: when ALL tools in the batch are Write or Edit operations,
   * errors do NOT cancel siblings — each file operation is independent and
   * the model benefits from knowing which specific operations succeeded vs
   * failed, rather than getting blanket cancellation.
   */
  private hasErrored = false;

  constructor(context: ToolContext, tools: readonly Tool[]) {
    this.context = context;
    this.availableTools = tools;
  }

  /**
   * Check whether ALL tools in the current batch are Write or Edit operations.
   * When true, error propagation is suppressed — individual file operations
   * are independent, and the model benefits from knowing which specific
   * writes/edits succeeded vs failed rather than receiving blanket
   * cancellation of siblings (§5.5 exception).
   */
  private allToolsAreWriteOrEdit(): boolean {
    for (const exec of this.queue) {
      if (exec.toolName !== "Write" && exec.toolName !== "Edit") {
        return false;
      }
    }
    return this.queue.length > 0;
  }

  /**
   * Add a tool_use block received from the API stream.
   */
  addTool(toolUse: ToolUseBlock): void {
    // Deduplicate: if a stream retry or API bug re-emits the same tool_use
    // block, skip it. Without this, the tool would be queued and executed a
    // second time — potentially double-writing a file, running a command
    // twice, or producing duplicate tool_result blocks that confuse the API
    // on the next turn.
    if (this.seenIds.has(toolUse.id)) {
      return;
    }
    this.seenIds.add(toolUse.id);

    const tool = findTool(toolUse.name);

    const execution: ToolExecution = {
      id: toolUse.id,
      // Use the tool's canonical name when found, falling back to the raw API
      // name for unknown/hallucinated tools. `findTool()` uses case-insensitive
      // fallback, so when the model emits "read" or "BASH", the tool resolves
      // correctly but `toolUse.name` retains the wrong case. This wrong-case
      // name flows into `tool_use` and `tool_result` LoopYield events, which
      // the REPL displays to the user (e.g., "⚙ read" instead of "⚙ Read")
      // and the model sees in sub-agent tool summaries. Using `tool.name`
      // ensures consistent canonical casing throughout the UI and conversation
      // context. For unknown tools, `toolUse.name` is preserved for the error
      // message ("Unknown tool 'foo'").
      toolName: tool?.name ?? toolUse.name,
      input: toolUse.input,
      state: "queued",
      // Unknown/hallucinated tools should be treated as concurrency-safe because
      // they do no real work — they just return an error message listing available
      // tools. Treating them as unsafe (the previous default) creates an unnecessary
      // barrier that blocks all subsequent queued tools until the no-op error
      // handler completes, adding latency when the model hallucinated one tool
      // name among several valid concurrent calls.
      isConcurrencySafe: tool?.isConcurrencySafe ?? true,
      tool,
    };

    this.queue.push(execution);
    this.queuedCount++;
    this.processQueue();
  }

  /**
   * Check if a tool can execute given current state.
   */
  private canExecuteTool(exec: ToolExecution): boolean {
    if (exec.isConcurrencySafe) {
      // Safe tools can run if no unsafe tool is currently executing
      // and we haven't hit the max parallelism cap.
      if (this.unsafeActiveCount > 0) return false;
      // Enforce max parallelism to prevent resource exhaustion (fd limits,
      // memory pressure) when the model emits many concurrent-safe tools.
      if (this.activeCount >= MAX_CONCURRENT_SAFE) return false;
      return true;
    } else {
      // Unsafe tools can only run if nothing else is executing
      return this.activeCount === 0;
    }
  }

  /**
   * Process the queue — start any eligible tools.
   *
   * Respects barrier semantics: an unsafe (non-concurrent) tool acts as a
   * barrier — no tool queued *after* it may start until the barrier tool
   * itself has completed. Without this, a sequence like
   *   [Read₁, Read₂, Write₃, Read₄]
   * would incorrectly start Read₄ in parallel with Read₁/Read₂, bypassing
   * the Write₃ barrier.
   */
  private processQueue(): void {
    // When the abort signal has fired, immediately complete all queued tools
    // with an "Aborted" result instead of silently leaving them in "queued"
    // state. Previously this method returned early on abort, but any tools
    // still in "queued" state would never transition to "completed" — their
    // queuedCount contribution would keep `pendingCount > 0`, causing
    // `getRemainingResults()` to wait forever (deadlock). This can happen
    // when abort fires between successive `addTool()` calls in loop.ts
    // (e.g., Ctrl+C while the model emitted multiple tool_use blocks).
    if (this.context.abortController.signal.aborted) {
      for (let i = this.nextQueuedIndex; i < this.queue.length; i++) {
        const exec = this.queue[i];
        if (exec.state !== "queued") continue;
        exec.state = "completed";
        exec.result = { content: "User rejected tool use", is_error: true };
        exec.durationMs = 0;
        this.queuedCount--;
        this.completedQueue.push(exec);
      }
      this.nextQueuedIndex = this.queue.length;
      // Notify waiter so getRemainingResults() can drain the completed items
      if (this.resolveWaiter) {
        this.resolveWaiter();
        this.resolveWaiter = null;
      }
      return;
    }

    // ── Error propagation (§5.5): cancel queued siblings when a tool has errored ──
    // When a tool errors during parallel execution, sibling tools that haven't
    // started receive a synthetic error. This prevents wasted execution on tools
    // whose results the model will discard anyway (it needs to re-plan after the
    // error). Exception: when ALL tools in the batch are Write or Edit, errors
    // do NOT cancel siblings — each file operation is independent.
    if (this.hasErrored) {
      for (let i = this.nextQueuedIndex; i < this.queue.length; i++) {
        const exec = this.queue[i];
        if (exec.state !== "queued") continue;
        exec.state = "completed";
        exec.result = {
          content: "<tool_use_error>Sibling tool call errored</tool_use_error>",
          is_error: true,
        };
        exec.durationMs = 0;
        this.queuedCount--;
        this.completedQueue.push(exec);
      }
      this.nextQueuedIndex = this.queue.length;
      if (this.resolveWaiter) {
        this.resolveWaiter();
        this.resolveWaiter = null;
      }
      return;
    }

    for (let i = this.nextQueuedIndex; i < this.queue.length; i++) {
      const exec = this.queue[i];
      if (exec.state !== "queued") {
        // This item has already transitioned to "executing"/"completed"/"yielded".
        // If it's at the current scan start, advance past it so future
        // processQueue() calls don't re-examine it (or any gap of completed
        // items between nextQueuedIndex and the first remaining "queued" item).
        // Without this, after an out-of-order completion, processQueue() would
        // re-scan all completed items in the gap on every re-entry — wasted
        // O(k) work per call where k is the gap size.
        if (i === this.nextQueuedIndex) this.nextQueuedIndex = i + 1;
        continue;
      }
      if (!this.canExecuteTool(exec)) {
        // If this queued tool can't run yet, stop processing further items.
        // This ensures barrier ordering: nothing after a blocked unsafe tool
        // can leapfrog it.
        break;
      }

      exec.state = "executing";
      this.activeCount++;
      this.queuedCount--;
      if (!exec.isConcurrencySafe) this.unsafeActiveCount++;
      // Advance the scan start index past this item. The next time
      // processQueue() runs, it won't re-examine this (or any earlier)
      // entry, turning the cumulative cost from O(n²) to O(n).
      this.nextQueuedIndex = i + 1;
      // Fire-and-forget: tools run concurrently and their results are
      // collected via completedQueue. Errors inside executeTool are caught
      // by its try/catch, but if the `finally` block itself threw (e.g., a
      // bug in processQueue()), the unhandled rejection would crash the
      // process. The `.catch()` ensures graceful degradation — the tool
      // will still be marked completed with an error result by the catch
      // block inside executeTool, and processQueue's failure would surface
      // as a stall rather than a crash. We log to stderr so the error is
      // visible for debugging — a silent `.catch(() => {})` would make
      // `finally` block bugs impossible to diagnose (the only symptom
      // would be an unexplained deadlock in getRemainingResults).
      this.executeTool(exec).catch((err: unknown) => {
        // Safety net: if executeTool's try/catch/finally somehow failed to
        // mark this tool as completed (e.g., a bug in the finally block that
        // throws before pushing to completedQueue), ensure it transitions to
        // "completed" here. Without this, the tool stays in "executing" state
        // forever — its activeCount contribution is never decremented, and
        // getRemainingResults() deadlocks waiting for a completion that never
        // arrives. This is a last-resort guard; under normal operation the
        // finally block in executeTool handles all completion bookkeeping.
        if (exec.state !== "completed" && exec.state !== "yielded") {
          exec.state = "completed";
          exec.result = {
            content: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          };
          exec.durationMs = 0; // unknown — executeTool's startTime is out of scope
          // Guard against double-decrement: if executeTool's finally block
          // partially completed (decremented activeCount) before throwing,
          // decrementing again here would make activeCount negative. A
          // negative activeCount breaks canExecuteTool() — it would allow
          // more concurrent tools than the limit, and pendingCount (which
          // depends on activeCount) would underflow. The Math.max(0, ...)
          // floor ensures we never go below zero, at the cost of a
          // potentially orphaned count (one fewer active slot than reality)
          // which self-corrects when the turn's remaining tools complete.
          this.activeCount = Math.max(0, this.activeCount - 1);
          if (!exec.isConcurrencySafe) this.unsafeActiveCount = Math.max(0, this.unsafeActiveCount - 1);
          this.completedQueue.push(exec);
          if (this.resolveWaiter) {
            this.resolveWaiter();
            this.resolveWaiter = null;
          }
          this.processQueue();
        }
        const msg = err instanceof Error ? err.message : String(err);
        // Use printWarning() instead of process.stderr.write() for consistent
        // terminal formatting. Direct stderr writes can interleave with the
        // spinner (which writes to stderr via `\r\x1b[K`) and produce garbled
        // output — the spinner's carriage-return clears the diagnostic line
        // before the user can read it. printWarning() uses console.log (stdout)
        // and formats with the standard "⚠ ..." prefix, matching the pattern
        // used by every other warning in the codebase.
        try { printWarning(`StreamingToolExecutor: Unexpected error in tool "${exec.toolName}": ${msg}`); } catch { /* best-effort */ }
      });

      // If we just started an unsafe tool, don't start anything else
      // in this pass — the barrier must execute alone.
      if (!exec.isConcurrencySafe) break;
    }
  }

  /**
   * Execute a single tool and handle its result.
   * Uses the tool reference cached on the ToolExecution at queue time,
   * avoiding a redundant second findTool() lookup.
   */
  private async executeTool(exec: ToolExecution): Promise<void> {
    const tool = exec.tool;
    const startTime = performance.now();

    try {
      let result: ToolResult;

      // Check if the user has aborted (Ctrl+C) before starting the tool.
      // Without this, queued tools would still execute after abort, wasting
      // time on tools whose results will be discarded.
      //
      // NOTE: We must NOT `return` here — the `finally` block must run to
      // decrement `activeCount`, push to `completedQueue`, and call
      // `processQueue()`. An early return would bypass `finally` and cause
      // `getRemainingResults()` to deadlock waiting for a completion
      // notification that never arrives.
      if (this.context.abortController.signal.aborted) {
        result = { content: "User rejected tool use", is_error: true };
      } else if (!tool) {
        // Truncate the tool name to prevent a hallucinated 100KB+ name from
        // wasting tokens in the tool_result sent back to the API. The raw
        // toolName is stored on the ToolExecution object from the API response
        // with no length sanitization — a model hallucination or adversarial
        // prompt could produce an arbitrarily long tool name string. While the
        // error message is small, including the full hallucinated name in the
        // tool_result content consumes context tokens proportional to the name
        // length, potentially triggering unnecessary auto-compaction. 100 chars
        // retains enough for diagnosis (real tool names are 3–10 chars).
        const displayName = exec.toolName.length > 100
          ? safeTruncate(exec.toolName, 100) + "…"
          : exec.toolName;
        result = {
          content: `Error: Unknown tool "${displayName}". Available tools: ${this.availableTools
            .map((t) => t.name)
            .join(", ")}`,
          is_error: true,
        };
      } else {
        // ── Explore Cache: check for cached result ──
        const cache = this.context.exploreCache;
        const isCacheable = tool.isConcurrencySafe && cache;
        let cached: ToolResult | undefined;

        if (isCacheable) {
          cached = cache.get(exec.toolName, exec.input, this.context.cwd);
        }

        if (cached) {
          result = cached;
        } else {
          // ── Retry for concurrency-safe (idempotent) tools ──
          // Safe tools (Read, Glob, Grep, WebFetch) are side-effect-free, so
          // retrying on transient OS errors (EMFILE, EAGAIN, EBUSY, EACCES on
          // a file lock) is safe and often resolves the issue without wasting
          // an API round-trip for the model to re-issue the tool call.
          // Unsafe tools (Write, Edit, Bash) are NOT retried because they may
          // have partially executed (e.g., partial file write, command with
          // side effects) — retrying could cause data corruption or duplicate
          // effects.
          const maxToolRetries = tool.isConcurrencySafe ? 1 : 0;
          let toolAttempt = 0;
          let lastToolErr: unknown;

          while (true) {
            try {
              result = await tool.execute(exec.input, this.context);
              lastToolErr = undefined;
              break;
            } catch (toolErr: unknown) {
              lastToolErr = toolErr;
              if (toolAttempt >= maxToolRetries) {
                throw toolErr; // Will be caught by the outer catch
              }
              toolAttempt++;
              // Brief pause before retry (100ms) — just enough for transient
              // fd exhaustion or file lock release, but not long enough to
              // noticeably delay the overall turn.
              await new Promise<void>((r) => setTimeout(r, 100));
            }
          }

          // If the tool returned is_error (not an exception), also retry once
          // for safe tools that hit transient errors.
          if (result!.is_error && tool.isConcurrencySafe && toolAttempt === 0) {
            const errorContent = typeof result!.content === "string" ? result!.content.toLowerCase() : "";
            const isTransient =
              errorContent.includes("emfile") ||
              errorContent.includes("eagain") ||
              errorContent.includes("ebusy") ||
              errorContent.includes("etimedout") ||
              errorContent.includes("econnreset");
            if (isTransient) {
              await new Promise<void>((r) => setTimeout(r, 100));
              try {
                const retryResult = await tool.execute(exec.input, this.context);
                if (!retryResult.is_error) {
                  result = retryResult;
                }
              } catch {
                // Keep the original error result
              }
            }
          }

          // ── Explore Cache: store result for cacheable tools ──
          if (isCacheable && !result.is_error) {
            const metadata = extractCacheMetadata(exec.toolName, exec.input, this.context.cwd);
            cache!.set(exec.toolName, exec.input, this.context.cwd, result, metadata);
          }

          // ── Explore Cache: invalidate on file modifications ──
          if (cache && !tool.isConcurrencySafe) {
            const modifiedPaths = extractModifiedPaths(exec.toolName, exec.input, this.context.cwd);
            for (const p of modifiedPaths) {
              cache.invalidateFile(p);
            }
            // Bash can modify any file — conservatively invalidate the
            // entire working directory scope for Glob/Grep entries.
            if (exec.toolName === "Bash") {
              cache.invalidateDirectory(this.context.cwd);
            }
          }
        }
      }

      exec.result = result;
      exec.durationMs = Math.round(performance.now() - startTime);
      exec.state = "completed";
      // ── Error propagation (§5.5): mark that a tool has errored ──
      // Set hasErrored so processQueue() cancels queued siblings with a
      // synthetic error. Exception: when ALL tools in the batch are Write
      // or Edit, individual file operations are independent — the model
      // benefits from knowing which specific writes/edits succeeded.
      if (result.is_error && !this.hasErrored && !this.allToolsAreWriteOrEdit()) {
        this.hasErrored = true;
      }
    } catch (err: unknown) {
      exec.error = err instanceof Error ? err : new Error(String(err));
      exec.result = {
        content: `Tool execution error: ${exec.error.message}`,
        is_error: true,
      };
      exec.durationMs = Math.round(performance.now() - startTime);
      exec.state = "completed";
      // Set hasErrored for exception-based failures too (same Write/Edit exception)
      if (!this.hasErrored && !this.allToolsAreWriteOrEdit()) {
        this.hasErrored = true;
      }
    } finally {
      // Floor guard matches the safety-net .catch() handler (line ~231).
      // Under normal operation activeCount should never reach 0 before this
      // decrement, but a hypothetical bug (e.g., executeTool invoked twice
      // for the same ToolExecution, or processQueue double-incrementing) could
      // underflow activeCount to -1, breaking canExecuteTool() — it checks
      // `this.activeCount === 0` for unsafe tools, which would never be true
      // with a negative value, deadlocking the queue. The floor guard prevents
      // this at the cost of a potentially stale count that self-corrects as
      // remaining tools complete.
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (!exec.isConcurrencySafe) this.unsafeActiveCount = Math.max(0, this.unsafeActiveCount - 1);
      this.completedQueue.push(exec);

      // Notify waiter
      if (this.resolveWaiter) {
        this.resolveWaiter();
        this.resolveWaiter = null;
      }

      // Process next in queue
      this.processQueue();
    }
  }

  /**
   * Wait for the next completed tool, or resolve immediately if items are
   * already queued. This prevents a race where a tool completes between the
   * `hasActive` check and the `await`, which would leave `resolveWaiter`
   * unresolved (deadlock).
   *
   * The double-check pattern (check → set waiter → re-check) ensures that a
   * tool completing between the outer check and the waiter assignment doesn't
   * produce a missed wake-up. In Node.js's single-threaded event loop, the
   * interleaving can't currently occur (both the check and assignment are
   * synchronous within the same microtask), but the defensive re-check makes
   * the code robust against future refactors that introduce async boundaries,
   * and against alternative runtimes (Deno, Bun) with different scheduling.
   */
  private waitForCompletion(): Promise<void> {
    // If something already completed while we were yielding, resolve immediately
    if (this.completedIdx < this.completedQueue.length) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.resolveWaiter = resolve;
      // Re-check after setting the waiter — a tool may have completed
      // between the outer check and this assignment. Without this, the
      // notification from that tool's `finally` block (which called
      // `this.resolveWaiter()` before it was set) would be lost, and
      // this Promise would never resolve (deadlock).
      if (this.completedIdx < this.completedQueue.length) {
        resolve();
        this.resolveWaiter = null;
      }
    });
  }

  /**
   * Async generator that yields completed tool results as they finish.
   */
  async *getRemainingResults(): AsyncGenerator<ToolExecution> {
    while (true) {
      // Yield all completed items using an index cursor (O(1) per element
      // vs O(n) for shift())
      while (this.completedIdx < this.completedQueue.length) {
        const item = this.completedQueue[this.completedIdx];
        // Null out the reference to release memory (tool result strings, input
        // objects, etc.) immediately after yielding instead of holding them until
        // the final cleanup. Previously this used `splice(0, completedIdx)` to
        // remove yielded entries, but splice is O(n) — it re-indexes all
        // remaining elements — negating the O(1) index-cursor optimization.
        // Nulling out individual entries is O(1) and achieves the same reference
        // release. The nulled slots are harmless: the index cursor advances past
        // them, and the array is bulk-cleared at the end (line below).
        this.completedQueue[this.completedIdx] = null;
        this.completedIdx++;
        // Skip null entries (shouldn't happen in normal operation — entries are
        // only nulled by this loop after yielding, and the index cursor advances
        // past them — but guard defensively since the array type is
        // `(ToolExecution | null)[]`).
        if (item === null) continue;
        item.state = "yielded";
        yield item;
      }

      // Check if there's anything still in flight — uses the existing
      // pendingCount getter which counts via a simple loop rather than
      // allocating a filtered array via `queue.some()`.
      if (this.pendingCount === 0) break;

      // Wait for next completion
      await this.waitForCompletion();
    }

    // All tools have been executed and yielded. Clear both queues to
    // release references held by completed ToolExecution entries (tool
    // reference, input object, result string, Error object). Without this,
    // the queue array retains all entries from this turn for the lifetime
    // of the executor instance — which is short-lived (created per-turn in
    // loop.ts), but the entries can be large (e.g., a Write tool's input
    // holding an entire file as a string, or a Bash tool's result
    // containing 30 KB of build output). The nextQueuedIndex optimization
    // already prevents re-scanning, so the entries serve no purpose after
    // yielding.
    this.queue.length = 0;
    this.nextQueuedIndex = 0;
    this.completedQueue.length = 0;
    this.completedIdx = 0;
    // Clear the dedup set along with the queues. The executor is
    // short-lived (created per-turn in loop.ts), so this is currently a
    // no-op before GC — but if the executor were ever reused across turns
    // (e.g., for batched streaming), stale IDs from a prior turn would
    // silently block legitimate new tool_use blocks with recycled IDs from
    // the API. Clearing the set makes the cleanup complete and the class
    // safe for hypothetical reuse.
    this.seenIds.clear();
    // Reset error propagation flag (§5.5) so a reused executor doesn't
    // carry stale error state into a new batch of tool calls.
    this.hasErrored = false;
  }

  /**
   * Get count of pending/executing tools. O(1) via maintained counters
   * instead of scanning the entire queue (which includes completed/yielded
   * items that accumulate over the lifetime of the executor).
   */
  get pendingCount(): number {
    return this.queuedCount + this.activeCount;
  }
}
