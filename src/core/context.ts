import type { ReadFileState, FileState, ToolContext } from "./types.js";
import { MAX_AGENT_DEPTH } from "./types.js";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { ExploreCache as ExploreCacheImpl } from "../utils/explore-cache.js";

class ReadFileStateImpl implements ReadFileState {
  private map = new Map<string, FileState>();
  // 500 entries accommodate large codebases where the agent may read hundreds
  // of files in a single session.  With 100 entries, legitimate files were
  // evicted prematurely, causing spurious "must read file before editing"
  // errors when the agent revisited an earlier file.
  private maxEntries = 500;

  get(path: string): FileState | undefined {
    const state = this.map.get(path);
    // Promote to most-recently-used by re-inserting (delete + set).
    // Without this, `get()` doesn't update the insertion order, so
    // frequently-read files can be evicted before files that were
    // written once but never read again.
    if (state !== undefined) {
      this.map.delete(path);
      this.map.set(path, state);
    }
    return state;
  }

  set(path: string, state: FileState): void {
    // LRU eviction: delete and re-insert to maintain order
    if (this.map.has(path)) {
      this.map.delete(path);
    } else if (this.map.size >= this.maxEntries) {
      // Evict oldest entry
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(path, state);
  }

  has(path: string): boolean {
    return this.map.has(path);
  }

  delete(path: string): boolean {
    return this.map.delete(path);
  }

  clone(): ReadFileState {
    const cloned = new ReadFileStateImpl();
    // Preserve the maxEntries limit so sub-agents (which use cloneContext →
    // readFileState.clone()) inherit the same LRU capacity. Without this,
    // cloned instances silently revert to the hardcoded default. Currently
    // maxEntries is a fixed constant (500), so this is a no-op — but if it's
    // ever made configurable (e.g., via config or a constructor parameter),
    // sub-agents would silently use a different capacity without this line.
    cloned.maxEntries = this.maxEntries;
    for (const [k, v] of this.map) {
      cloned.map.set(k, { ...v });
    }
    return cloned;
  }

  clear(): void {
    this.map.clear();
  }
}

export function createContext(cwd?: string): ToolContext {
  // Resolve the working directory. process.cwd() can throw ENOENT if the
  // current directory was deleted while the process is running (or between
  // startup and this call). Fall back to the OS home directory or a
  // platform-appropriate root so the agent can still start — the user can
  // then use Bash to `cd` into a valid directory. Without this, an
  // unhandled ENOENT would crash the entire REPL before the user sees any UI.
  //
  // Guard against empty string cwd: `""` is falsy so it hits the fallback
  // (correct), but `"  "` (whitespace-only) is truthy and bypasses it —
  // `resolve("  ", "file.ts")` produces a path with embedded spaces that
  // doesn't match any real directory, causing confusing ENOENT errors
  // downstream. Trim and treat whitespace-only as missing.
  let resolvedCwd = cwd?.trim() || undefined;
  if (!resolvedCwd) {
    try {
      resolvedCwd = process.cwd();
    } catch {
      // Fallback priority: user home directory, then platform-appropriate root.
      //
      // On Windows, `"/"` resolves to the root of the current drive (e.g.,
      // `C:\`), which depends on the now-deleted cwd's drive letter — an
      // awkward assumption. The last-resort fallback uses `os.tmpdir()`
      // (typically `C:\Users\<user>\AppData\Local\Temp`) which is always
      // writable by the current user. Previously this used `%SystemRoot%`
      // (`C:\Windows`), which is NOT writable by normal users — Write, Edit,
      // and Bash tool calls would fail with EACCES/EPERM, and the user would
      // get "Permission denied" errors with no indication that the problem
      // is the fallback cwd, not the specific file they're trying to write.
      //
      // `os.tmpdir()` is preferred over `%TEMP%` (which `os.tmpdir()` reads
      // internally on Windows) because `os.tmpdir()` handles edge cases like
      // missing `TEMP`/`TMP` env vars, falling back to `%SystemRoot%` only
      // as a last resort. On Unix-like systems, `/` is the standard
      // filesystem root and is always a valid cwd (even if not writable).
      resolvedCwd =
        process.env.HOME ||
        process.env.USERPROFILE ||
        (process.platform === "win32"
          ? tmpdir() || "C:\\"
          : "/");
    }
  }
  return {
    readFileState: new ReadFileStateImpl(),
    abortController: new AbortController(),
    agentId: randomUUID(),
    depth: 0,
    cwd: resolvedCwd,
    exploreCache: new ExploreCacheImpl(),
  };
}

/**
 * Clone a parent context to create a child context for sub-agent execution.
 *
 * The child inherits the parent's readFileState (deep clone), cwd, and
 * spawnAgent function. Abort signals propagate from parent → child.
 *
 * **IMPORTANT — Disposal requirement:**
 * The child context registers an abort listener on the parent's signal to
 * propagate cancellation. This listener is cleaned up automatically when
 * *either* the parent or child is aborted. If the child completes normally
 * without being aborted, the listener persists on the parent's signal for
 * the parent's entire lifetime, leaking memory proportional to the number
 * of sub-agent spawns. **Callers must abort the child context when it is no
 * longer needed**, even on successful completion:
 *
 * ```ts
 * const child = cloneContext(parent);
 * try {
 *   // ... use child ...
 * } finally {
 *   if (!child.abortController.signal.aborted) {
 *     child.abortController.abort();
 *   }
 * }
 * ```
 *
 * `spawnAgent()` in agent.ts already does this in its `finally` block.
 */
export function cloneContext(parent: ToolContext): ToolContext {
  // Defense-in-depth: reject if the parent is already at or beyond the max
  // depth. The Task tool and spawnAgent both check this, but cloneContext is
  // a public function that could be called from other code paths. Without
  // this guard, a bug in a new caller could create unbounded recursion.
  // Guard against non-finite depth values (NaN, Infinity, -Infinity). These
  // can arise from corrupt restored sessions where `depth` was deserialized as
  // a non-numeric value (e.g., `undefined + 1 = NaN` if the session file's
  // depth field was missing). `NaN >= 5` evaluates to `false`, so a NaN depth
  // would bypass the MAX_AGENT_DEPTH check, and `NaN + 1` propagates NaN to
  // every child — allowing unbounded recursion that eventually exhausts the
  // call stack or API credits. Treat non-finite depth as an error: the call
  // site should fix the parent's depth before cloning.
  if (!Number.isFinite(parent.depth) || parent.depth < 0) {
    throw new Error(
      `Cannot clone context: invalid parent depth (${parent.depth}). ` +
      `Expected a non-negative integer, got ${typeof parent.depth === "number" ? parent.depth : typeof parent.depth}.`
    );
  }
  if (parent.depth >= MAX_AGENT_DEPTH) {
    throw new Error(
      `Cannot clone context: maximum agent depth (${MAX_AGENT_DEPTH}) reached. ` +
      `Current depth: ${parent.depth}.`
    );
  }

  const childAbort = new AbortController();
  // Capture the parent's abort signal at clone time. We must NOT re-read
  // `parent.abortController.signal` in closures below because the parent's
  // `abortController` property may be reassigned after cloning (e.g., in
  // index.ts when Ctrl+C fires: `context.abortController = new AbortController()`).
  // If closures read the property dynamically, they would operate on the
  // WRONG signal — the propagateAbort listener was registered on the OLD
  // signal, but the cleanup removeEventListener would target the NEW signal,
  // causing a memory leak (old listener never removed) and a no-op removal.
  const parentSignal = parent.abortController.signal;

  // If the parent is already aborted at clone time, abort the child
  // immediately. Without this check, the "abort" event listener below
  // would never fire (the event already happened), creating a zombie
  // child context that ignores the parent's cancellation.
  if (parentSignal.aborted) {
    // Propagate the parent's abort reason so the child inherits the specific
    // cause (e.g., a TimeoutError vs a manual cancellation). Without passing
    // the reason, childAbort.abort() creates a generic DOMException with
    // name "AbortError", losing the diagnostic information — making it
    // impossible to distinguish a timeout-triggered abort from a user Ctrl+C
    // in error messages and logging downstream.
    childAbort.abort(parentSignal.reason);
  } else {
    // If parent aborts in the future, abort child too. Use { once: true }
    // to auto-cleanup the listener after it fires, preventing memory leaks
    // from accumulating listeners on the parent signal across many sub-agent spawns.
    const propagateAbort = () => {
      // Pass the parent's abort reason to the child so downstream error
      // handlers can distinguish timeout-triggered aborts from user
      // cancellations. Without this, the child gets a generic DOMException
      // ("AbortError") regardless of why the parent was actually aborted.
      childAbort.abort(parentSignal.reason);
    };
    parentSignal.addEventListener(
      "abort",
      propagateAbort,
      { once: true }
    );

    // Also clean up the listener when the child is aborted independently
    // (e.g., when the sub-agent completes and the child context is discarded).
    // Without this, the listener persists on the parent signal for the entire
    // session lifetime, leaking memory proportional to the number of sub-agent
    // spawns — since { once: true } only fires on abort, not on disposal.
    childAbort.signal.addEventListener(
      "abort",
      () => {
        parentSignal.removeEventListener("abort", propagateAbort);
      },
      { once: true }
    );
  }

  return {
    readFileState: parent.readFileState.clone(),
    abortController: childAbort,
    agentId: randomUUID(),
    depth: parent.depth + 1,
    cwd: parent.cwd,
    exploreCache: parent.exploreCache?.clone(),
    spawnAgent: parent.spawnAgent,
  };
}
