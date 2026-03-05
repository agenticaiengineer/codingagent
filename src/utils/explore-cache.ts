/**
 * Exploration Cache — caches results from read-only tools (Read, Glob, Grep)
 * so repeated explorations reuse previous results instead of re-executing.
 *
 * ## Design Principles
 *
 * 1. **Separation**: Only read-only, concurrency-safe tools are cached (Read,
 *    Glob, Grep). Write/Edit/Bash are never cached — they mutate state.
 *
 * 2. **Invalidation Strategy**:
 *    - **File-level**: When a file is written/edited, all Read cache entries
 *      for that path are invalidated. Glob/Grep entries whose search scope
 *      includes the modified path are also invalidated.
 *    - **Directory-level**: Glob and Grep results are invalidated when ANY
 *      file in their search scope is modified (conservative but correct).
 *    - **Mtime-based**: Read entries store the file's mtime at read time.
 *      On cache hit, the current mtime is compared — stale entries are
 *      evicted and re-executed.
 *    - **TTL**: Glob/Grep entries expire after a configurable TTL (default
 *      30s) since they scan many files and mtime-checking all of them
 *      would negate the caching benefit.
 *    - **Manual**: `cache.clear()` resets everything (used on session reset,
 *      /undo, etc.).
 *
 * 3. **Cache Key**: Deterministic hash of (tool_name + sorted JSON of input
 *    parameters + cwd). Ensures that identical tool calls from different
 *    cwds don't collide.
 *
 * 4. **LRU Eviction**: Maximum 200 entries (configurable). Oldest entries
 *    are evicted when the cap is reached.
 *
 * 5. **Context Integration**: The cache is attached to `ToolContext` and
 *    plumbed through tool execution. The `withExploreCache()` wrapper
 *    intercepts cacheable tool calls transparently.
 */

import { statSync } from "fs";
import { resolve, normalize } from "path";
import { createHash } from "crypto";
import type { ToolResult, SerializedExploreCache } from "../core/types.js";

// ── Cache Entry ──

export interface CacheEntry {
  /** The cached tool result. */
  result: ToolResult;
  /** Unix timestamp (ms) when this entry was created. */
  createdAt: number;
  /** Tool name that produced this result. */
  toolName: string;
  /**
   * For Read entries: the absolute file path and its mtime at read time.
   * For Glob/Grep entries: the search directory path.
   * Used for targeted invalidation.
   */
  filePath?: string;
  fileMtimeMs?: number;
  /**
   * For Glob/Grep: the directory that was searched. Any file modification
   * under this directory triggers invalidation of this entry.
   */
  searchScope?: string;
}

// ── Configuration ──

export interface ExploreCacheConfig {
  /** Maximum number of cached entries (LRU eviction). Default: 200. */
  maxEntries: number;
  /** TTL in milliseconds for Glob/Grep entries. Default: 30000 (30s). */
  directoryTtlMs: number;
  /** Whether the cache is enabled. Default: true. */
  enabled: boolean;
}

const DEFAULT_CONFIG: ExploreCacheConfig = {
  maxEntries: 200,
  directoryTtlMs: 30_000,
  enabled: true,
};

// ── Tools eligible for caching ──

/** Only these read-only tools are cached. */
const CACHEABLE_TOOLS = new Set(["Read", "Glob", "Grep"]);

/** Tools whose execution can invalidate cached entries. */
const INVALIDATING_TOOLS = new Set(["Write", "Edit", "Bash"]);

// ── Cache Key Generation ──

/**
 * Generate a deterministic cache key from tool name + input + cwd.
 *
 * Uses SHA-256 of the canonical JSON to produce a fixed-length key.
 * Input parameters are sorted by key name to ensure determinism
 * (LLM tool calls may vary property order across invocations).
 */
export function makeCacheKey(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): string {
  const sortedInput = Object.keys(input)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = input[key];
      return acc;
    }, {});

  const raw = JSON.stringify({ tool: toolName, input: sortedInput, cwd });
  return createHash("sha256").update(raw).digest("hex");
}

// ── Explore Cache Implementation ──

export class ExploreCache {
  private cache = new Map<string, CacheEntry>();
  private config: ExploreCacheConfig;

  /** Statistics for monitoring cache effectiveness. */
  private stats = { hits: 0, misses: 0, invalidations: 0, evictions: 0 };

  constructor(config?: Partial<ExploreCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Core API ──

  /**
   * Look up a cached result for a tool call.
   * Returns the cached result if valid, or undefined if not cached / stale.
   */
  get(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string
  ): ToolResult | undefined {
    if (!this.config.enabled || !CACHEABLE_TOOLS.has(toolName)) return undefined;

    const key = makeCacheKey(toolName, input, cwd);
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Validate freshness
    if (!this.isEntryFresh(entry)) {
      this.cache.delete(key);
      this.stats.misses++;
      this.stats.invalidations++;
      return undefined;
    }

    // LRU promotion: delete and re-insert to maintain order
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.stats.hits++;
    return entry.result;
  }

  /**
   * Store a tool result in the cache.
   */
  set(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
    result: ToolResult,
    metadata?: { filePath?: string; fileMtimeMs?: number; searchScope?: string }
  ): void {
    if (!this.config.enabled || !CACHEABLE_TOOLS.has(toolName)) return;

    // Don't cache error results — they are transient (ENOENT, EACCES, timeout)
    // and should be re-attempted. Caching an error would mask the fix when the
    // user resolves the underlying issue (e.g., creating a missing file).
    if (result.is_error) return;

    const key = makeCacheKey(toolName, input, cwd);

    // LRU eviction
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.config.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
        this.stats.evictions++;
      }
    }

    const entry: CacheEntry = {
      result,
      createdAt: Date.now(),
      toolName,
      ...metadata,
    };

    this.cache.set(key, entry);
  }

  // ── Invalidation ──

  /**
   * Invalidate cache entries affected by a file modification.
   *
   * Called when Write, Edit, or Bash modifies files.
   * - Read entries for the exact path are removed.
   * - Glob/Grep entries whose searchScope includes the modified path are removed.
   *
   * @param modifiedPath Absolute path of the modified file.
   */
  invalidateFile(modifiedPath: string): void {
    const normalizedPath = normalize(modifiedPath);

    const keysToDelete: string[] = [];
    for (const [key, entry] of this.cache) {
      // Exact path match for Read entries
      if (entry.toolName === "Read" && entry.filePath) {
        if (normalize(entry.filePath) === normalizedPath) {
          keysToDelete.push(key);
          continue;
        }
      }

      // Scope-based invalidation for Glob/Grep entries:
      // If the modified file is under the search scope, the results
      // may be different now (new file found, file content changed, etc.)
      if (
        (entry.toolName === "Glob" || entry.toolName === "Grep") &&
        entry.searchScope
      ) {
        const normalizedScope = normalize(entry.searchScope);
        if (normalizedPath.startsWith(normalizedScope)) {
          keysToDelete.push(key);
        }
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this.stats.invalidations++;
    }
  }

  /**
   * Invalidate ALL Glob and Grep entries whose search scope falls under
   * a given directory. Used when Bash runs a command that may have modified
   * files in an unpredictable way (we don't know which files were touched).
   *
   * @param directory The directory where Bash ran (typically cwd).
   */
  invalidateDirectory(directory: string): void {
    const normalizedDir = normalize(directory);

    const keysToDelete: string[] = [];
    for (const [key, entry] of this.cache) {
      // Invalidate Read entries under this directory
      if (entry.toolName === "Read" && entry.filePath) {
        if (normalize(entry.filePath).startsWith(normalizedDir)) {
          keysToDelete.push(key);
          continue;
        }
      }

      // Invalidate Glob/Grep entries that searched this directory or within it
      if (
        (entry.toolName === "Glob" || entry.toolName === "Grep") &&
        entry.searchScope
      ) {
        const normalizedScope = normalize(entry.searchScope);
        // Bidirectional: scope under dir OR dir under scope
        if (
          normalizedScope.startsWith(normalizedDir) ||
          normalizedDir.startsWith(normalizedScope)
        ) {
          keysToDelete.push(key);
        }
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this.stats.invalidations++;
    }
  }

  /**
   * Clear all cached entries. Called on session reset, /undo, etc.
   */
  clear(): void {
    this.cache.clear();
  }

  // ── Freshness checks ──

  /**
   * Check whether a cache entry is still valid.
   */
  private isEntryFresh(entry: CacheEntry): boolean {
    const now = Date.now();

    // TTL check for Glob/Grep entries
    if (
      (entry.toolName === "Glob" || entry.toolName === "Grep") &&
      now - entry.createdAt > this.config.directoryTtlMs
    ) {
      return false;
    }

    // Mtime check for Read entries — compare against current file mtime
    if (entry.toolName === "Read" && entry.filePath && entry.fileMtimeMs !== undefined) {
      try {
        const currentStat = statSync(entry.filePath);
        // Use 1ms tolerance: filesystem clocks can differ slightly, and
        // some operations update mtime in the same millisecond as the read.
        if (Math.abs(currentStat.mtimeMs - entry.fileMtimeMs) > 1) {
          return false;
        }
      } catch {
        // File was deleted or is inaccessible — entry is stale
        return false;
      }
    }

    return true;
  }

  // ── Statistics ──

  getStats(): { hits: number; misses: number; invalidations: number; evictions: number; size: number } {
    return { ...this.stats, size: this.cache.size };
  }

  /**
   * Reset statistics counters. Useful for per-turn monitoring.
   */
  resetStats(): void {
    this.stats = { hits: 0, misses: 0, invalidations: 0, evictions: 0 };
  }

  // ── Clone (for sub-agents) ──

  /**
   * Create a shallow clone of the cache for sub-agent contexts.
   * Sub-agents share the parent's cached exploration results but
   * their invalidations don't propagate back to the parent.
   */
  clone(): ExploreCache {
    const cloned = new ExploreCache(this.config);
    for (const [key, entry] of this.cache) {
      cloned.cache.set(key, { ...entry });
    }
    return cloned;
  }

  // ── Serialization (session persistence) ──

  /**
   * Serialize the cache for session persistence.
   *
   * Only Read entries are persisted — they have mtime-based freshness
   * validation that works across sessions (the file's mtime is checked on
   * restore, so stale entries are automatically discarded). Glob/Grep
   * entries use short TTLs (30s default) that would be expired by the time
   * a session is resumed, so persisting them would be wasted bytes.
   */
  serialize(): SerializedExploreCache {
    const entries: SerializedExploreCache["entries"] = [];
    for (const [key, entry] of this.cache) {
      // Only persist Read entries — Glob/Grep TTLs are too short to survive
      // a session save/restore cycle.
      if (entry.toolName !== "Read") continue;
      // Skip entries without file metadata — they can't be validated on restore
      if (!entry.filePath || entry.fileMtimeMs === undefined) continue;
      entries.push({
        key,
        result: entry.result,
        createdAt: entry.createdAt,
        toolName: entry.toolName,
        filePath: entry.filePath,
        fileMtimeMs: entry.fileMtimeMs,
      });
    }
    return { version: 1, entries };
  }

  /**
   * Restore cache entries from a serialized snapshot.
   *
   * Each entry is validated against the file's current mtime before being
   * added — if the file was modified since the session was saved, the entry
   * is silently discarded. This ensures resumed sessions never serve stale
   * file content from a previous session.
   */
  restore(data: SerializedExploreCache): void {
    if (!data || data.version !== 1 || !Array.isArray(data.entries)) return;

    let restored = 0;
    for (const entry of data.entries) {
      // Basic shape validation — reject corrupt entries
      if (
        typeof entry.key !== "string" ||
        typeof entry.toolName !== "string" ||
        entry.toolName !== "Read" ||
        !entry.result ||
        typeof entry.result.content !== "string" ||
        typeof entry.filePath !== "string" ||
        typeof entry.fileMtimeMs !== "number" ||
        !Number.isFinite(entry.fileMtimeMs)
      ) {
        continue;
      }

      // Validate against current file mtime — discard stale entries
      try {
        const currentStat = statSync(entry.filePath);
        if (Math.abs(currentStat.mtimeMs - entry.fileMtimeMs) > 1) {
          // File was modified since the session was saved — skip
          continue;
        }
      } catch {
        // File was deleted or is inaccessible — skip
        continue;
      }

      // LRU eviction: respect maxEntries limit during restore
      if (this.cache.size >= this.config.maxEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) {
          this.cache.delete(oldest);
          this.stats.evictions++;
        }
      }

      this.cache.set(entry.key, {
        result: { content: entry.result.content, is_error: entry.result.is_error },
        createdAt: entry.createdAt,
        toolName: entry.toolName,
        filePath: entry.filePath,
        fileMtimeMs: entry.fileMtimeMs,
      });
      restored++;
    }
  }
}

// ── Helper: Extract metadata for caching ──

/**
 * Extract caching metadata from a tool's input parameters.
 * Used by the cache wrapper to determine file paths and search scopes.
 */
export function extractCacheMetadata(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): { filePath?: string; fileMtimeMs?: number; searchScope?: string } {
  switch (toolName) {
    case "Read": {
      const rawPath = typeof input.file_path === "string" ? input.file_path.trim() : undefined;
      if (rawPath) {
        const absPath = resolve(cwd, rawPath);
        let mtimeMs: number | undefined;
        try {
          mtimeMs = statSync(absPath).mtimeMs;
        } catch {
          // File doesn't exist or can't be stat'd — will be caught by tool
        }
        return { filePath: absPath, fileMtimeMs: mtimeMs };
      }
      return {};
    }
    case "Glob":
    case "Grep": {
      const pathInput = typeof input.path === "string" ? input.path.trim() : undefined;
      const searchScope = pathInput ? resolve(cwd, pathInput) : cwd;
      return { searchScope };
    }
    default:
      return {};
  }
}

/**
 * Extract modified file paths from a tool's input and result,
 * for cache invalidation purposes.
 */
export function extractModifiedPaths(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): string[] {
  switch (toolName) {
    case "Write":
    case "Edit": {
      const rawPath = typeof input.file_path === "string" ? input.file_path.trim() : undefined;
      if (rawPath) {
        return [resolve(cwd, rawPath)];
      }
      return [];
    }
    case "Bash":
      // Bash can modify any file — we can't know which ones.
      // The caller should use invalidateDirectory() instead.
      return [];
    default:
      return [];
  }
}

// ── Singleton for the global cache ──

let globalCache: ExploreCache | undefined;

export function getExploreCache(): ExploreCache {
  if (!globalCache) {
    globalCache = new ExploreCache();
  }
  return globalCache;
}

export function resetExploreCache(): void {
  globalCache?.clear();
  globalCache = undefined;
}
