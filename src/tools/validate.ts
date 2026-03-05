/**
 * Runtime input validation helpers for tool parameters.
 *
 * Every tool receives `input: Record<string, unknown>` from the LLM.
 * These helpers validate types at runtime and throw a ToolInputError
 * with a user-friendly message when the input is malformed.
 */

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * Validate that a required string parameter is present and is a string.
 * Returns the string value or throws a user-friendly error.
 */
export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    let actual: string;
    if (value === undefined) {
      actual = "missing";
    } else if (value === null) {
      actual = "null";
    } else {
      // Guard against JSON.stringify throwing on values with circular references
      // (possible from malformed LLM input or restored sessions with corrupt data).
      // Without this try/catch, a circular value would crash the entire validation
      // path, and the ToolInputError would never be created — the raw TypeError
      // ("Converting circular structure to JSON") would bubble up as an unhandled
      // tool execution error instead of the helpful "expected a non-empty string" message.
      let repr: string;
      try {
        repr = JSON.stringify(value);
      } catch {
        repr = "(non-serializable)";
      }
      actual = safeTruncate(`${typeof value} (${repr})`, 80);
    }
    throw new ToolInputError(`Missing or invalid required parameter "${key}": expected a non-empty string, got ${actual}`);
  }
  return value;
}

/**
 * Validate a required file path parameter. Wraps `requireString` and
 * additionally:
 *   1. Trims leading/trailing whitespace — LLMs sometimes emit paths with
 *      trailing spaces or newlines (e.g., `"src/app.ts "` or `"src/app.ts\n"`).
 *      `resolve(cwd, "src/app.ts ")` produces a path with a trailing space
 *      that doesn't match the actual file, causing a confusing ENOENT error
 *      with an invisible space in the error message. Trimming silently fixes
 *      this without changing semantics (legitimate file names never start or
 *      end with whitespace on any OS).
 *   2. Rejects whitespace-only paths — `"   "` passes `requireString` (non-empty)
 *      but `resolve(cwd, "   ")` produces `C:\src\project\   ` which always
 *      fails with ENOENT, showing a path with invisible trailing spaces.
 *   3. Rejects paths containing null bytes — on POSIX systems, `\0` is the path
 *      separator and cannot appear in file names. Node.js `fs` APIs throw a
 *      `TypeError` with a confusing message ("path must be a string without null
 *      bytes") that doesn't mention the parameter name or tool context. Catching
 *      it here provides a clear, actionable error. This mirrors the null-byte
 *      validation already in bash.ts for commands, where `\0` causes silent
 *      truncation — in file paths it causes hard crashes instead.
 */
export function requireFilePath(input: Record<string, unknown>, key: string): string {
  const raw = requireString(input, key);
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ToolInputError(`Missing or invalid required parameter "${key}": path is empty (whitespace only)`);
  }
  if (trimmed.includes("\0")) {
    throw new ToolInputError(`Invalid parameter "${key}": file path contains null byte(s). Remove any \\0 characters from the path.`);
  }
  return trimmed;
}

/**
 * Validate an optional string parameter.
 *
 * Returns `undefined` for missing/null values, empty strings, AND
 * whitespace-only strings (e.g., `"  "`, `"\n\t"`). This matches
 * `requireString`'s rejection of empty strings and extends it to
 * whitespace-only values — without this, callers must individually
 * trim and guard against whitespace-only strings that downstream
 * code treats as meaningful values.
 *
 * Previously only empty strings were normalized to `undefined`, so
 * whitespace-only values like `"   "` passed through. This caused:
 *   - `optionalString(input, "model")` returning `"  "` → API 404
 *     "model not found" (task.ts had a manual `.trim() || undefined`
 *     workaround; other callers did not)
 *   - `optionalString(input, "path")` returning `"  "` → resolved
 *     to a directory named `"  "` that doesn't exist (ENOENT)
 *   - `optionalString(input, "glob")` returning `"\t"` → passed to
 *     ripgrep as `--glob "\t"`, matching nothing (no error, just
 *     confusingly empty results)
 *   - `optionalString(input, "type")` returning `" "` → passed to
 *     ripgrep as `--type " "` → "Unrecognized file type" error
 *
 * Now all callers get consistent behavior: whitespace-only optional
 * strings are treated as "not provided", and manual `.trim() || undefined`
 * workarounds are no longer needed.
 *
 * Callers that legitimately need to preserve whitespace-only strings
 * (none currently exist) should use `input[key]` directly.
 */
export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ToolInputError(`Invalid parameter "${key}": expected a string, got ${typeof value}`);
  }
  // Treat empty and whitespace-only strings as "not provided". Empty strings
  // are consistent with requireString's rejection; whitespace-only strings
  // extend this to cover `"  "`, `"\n\t"`, etc. which pass through downstream
  // as seemingly valid values but cause confusing errors (ENOENT for paths,
  // 404 for model names, empty results for glob/type filters). Previously
  // only `value.length === 0` was checked, requiring callers like task.ts to
  // add manual `rawModel?.trim() || undefined` workarounds.
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Return the trimmed value, not the original. LLMs sometimes emit optional
  // parameters with leading/trailing whitespace (e.g., `" claude-sonnet "`,
  // `" content "`, `" *.ts "`). The original code returned `value` (untrimmed),
  // which silently passed through to downstream comparisons and API calls:
  //   - task.ts model: `" claude-sonnet "` → API 404 "model not found"
  //   - grep.ts output_mode: `" content "` → fails `includes()` check → error
  //   - grep.ts type: `" js "` → ripgrep "unrecognized file type" error
  //   - task.ts subagent_type: `" Explore "` → "unknown agent type" error
  //   - web.ts type: `" web "` → fails `!== "web"` check → "invalid search type"
  //   - glob.ts/grep.ts path: `" src "` → resolve produces path with spaces → ENOENT
  // All of these produce confusing errors with no indication that whitespace
  // in the parameter value is the cause. Trimming here fixes all callers
  // systematically, matching the trimming behavior already in `requireFilePath`.
  return trimmed;
}

/**
 * Validate an optional number parameter.
 */
export function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") {
    throw new ToolInputError(`Invalid parameter "${key}": expected a number, got ${typeof value}`);
  }
  // Reject NaN and Infinity — these are technically typeof "number" but
  // cause subtle downstream bugs (e.g., timeout: NaN, offset: Infinity).
  if (!Number.isFinite(value)) {
    throw new ToolInputError(`Invalid parameter "${key}": expected a finite number, got ${value}`);
  }
  return value;
}

/**
 * Validate a required number parameter.
 *
 * Like `optionalNumber`, rejects NaN and Infinity. Unlike `optionalNumber`,
 * throws when the parameter is missing (undefined/null) instead of returning
 * undefined. Use this for parameters that must always be present and numeric.
 */
export function requireNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (value === undefined || value === null) {
    throw new ToolInputError(`Missing required parameter "${key}": expected a number`);
  }
  if (typeof value !== "number") {
    throw new ToolInputError(`Invalid parameter "${key}": expected a number, got ${typeof value}`);
  }
  if (!Number.isFinite(value)) {
    throw new ToolInputError(`Invalid parameter "${key}": expected a finite number, got ${value}`);
  }
  return value;
}

/**
 * Validate an optional integer parameter.
 *
 * Rejects NaN, Infinity, and non-integer values (e.g., 2.5).
 * Use this instead of `optionalNumber` for parameters that must be
 * whole numbers (line offsets, limits, timeouts), preventing silent
 * truncation by `Array.prototype.slice` or `Math.round` scattering.
 */
export function optionalInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") {
    throw new ToolInputError(`Invalid parameter "${key}": expected an integer, got ${typeof value}`);
  }
  if (!Number.isFinite(value)) {
    throw new ToolInputError(`Invalid parameter "${key}": expected a finite integer, got ${value}`);
  }
  if (!Number.isInteger(value)) {
    // Suggest both floor and ceil when they differ, so the model can pick the
    // intended value. Previously only `Math.round` was suggested, which is
    // ambiguous for values like 2.5 (rounds to 3, but the model may want 2)
    // and loses information for values like 1.9 (rounds to 2, but the model
    // may have meant 1, e.g., for a 0-based offset). When floor === ceil
    // (shouldn't happen for non-integers, but guard defensively), show just one.
    const lo = Math.floor(value);
    const hi = Math.ceil(value);
    const suggestion = lo === hi ? `Use ${lo} instead.` : `Use ${lo} or ${hi} instead.`;
    throw new ToolInputError(`Invalid parameter "${key}": expected an integer, got ${value} (decimal). ${suggestion}`);
  }
  return value;
}

/**
 * Validate a required integer parameter.
 *
 * Like `optionalInteger`, rejects NaN, Infinity, and non-integer values.
 * Unlike `optionalInteger`, throws when the parameter is missing instead
 * of returning undefined.
 */
export function requireInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (value === undefined || value === null) {
    throw new ToolInputError(`Missing required parameter "${key}": expected an integer`);
  }
  if (typeof value !== "number") {
    throw new ToolInputError(`Invalid parameter "${key}": expected an integer, got ${typeof value}`);
  }
  if (!Number.isFinite(value)) {
    throw new ToolInputError(`Invalid parameter "${key}": expected a finite integer, got ${value}`);
  }
  if (!Number.isInteger(value)) {
    const lo = Math.floor(value);
    const hi = Math.ceil(value);
    const suggestion = lo === hi ? `Use ${lo} instead.` : `Use ${lo} or ${hi} instead.`;
    throw new ToolInputError(`Invalid parameter "${key}": expected an integer, got ${value} (decimal). ${suggestion}`);
  }
  return value;
}

/**
 * Validate an optional boolean parameter.
 */
export function optionalBool(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ToolInputError(`Invalid parameter "${key}": expected a boolean, got ${typeof value}`);
  }
  return value;
}

// ── String truncation ──

/**
 * Truncate a string to at most `maxLen` UTF-16 code units without splitting
 * a surrogate pair.  JavaScript's `substring()` operates on code units, so
 * cutting at an index between a high surrogate (0xD800–0xDBFF) and its low
 * surrogate (0xDC00–0xDFFF) produces a lone surrogate — malformed Unicode
 * that can cause JSON encoding errors, garbled API responses, or display
 * corruption.
 *
 * If the cut point lands on a high surrogate, backs up by one so the pair
 * is excluded entirely rather than split.
 *
 * This is the shared version of the truncation logic previously duplicated
 * inline in compaction.ts, bash.ts, grep.ts, web.ts, edit.ts, and read.ts.
 */
export function safeTruncate(str: string, maxLen: number): string {
  // Guard against non-finite maxLen values. NaN comparisons are always false,
  // so `NaN <= 0` and `str.length <= NaN` both return false, falling through
  // to `str.substring(0, NaN)` which returns "" — silently truncating the
  // entire string with no indication of what happened. For NaN, the safe
  // behavior is to return the string unmodified (no truncation intended).
  // Infinity is handled correctly by the `str.length <= maxLen` check below
  // (always true), but the explicit guard makes the intent clear.
  if (!Number.isFinite(maxLen)) return str;
  if (maxLen <= 0) return "";
  if (str.length <= maxLen) return str;
  let end = maxLen;
  if (end > 0) {
    const code = str.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      // Cut lands after a high surrogate — back up by one to exclude
      // the lone high surrogate entirely rather than splitting the pair.
      end--;
    } else if (end < str.length) {
      const nextCode = str.charCodeAt(end);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        // Cut lands between a surrogate pair: charCodeAt(end) is a low
        // surrogate, meaning charCodeAt(end-1) is its high surrogate.
        // Back up by one to exclude the entire pair rather than orphaning
        // the low surrogate from its high surrogate. Without this, the
        // returned string ends with a lone high surrogate — malformed
        // Unicode that can cause JSON encoding errors or display corruption.
        end--;
      }
    }
  }
  return str.substring(0, end);
}

// ── Error type guards ──

/**
 * Count the number of lines in a string without allocating an intermediate array.
 * `str.split("\n").length` creates an array of N+1 elements just to read `.length` —
 * for a 10 MB file that's ~200K array slots allocated and immediately discarded.
 * This loop-based approach is O(n) with zero allocation overhead.
 *
 * Shared between edit.ts and write.ts (previously duplicated in both files).
 * Lives in validate.ts because both tools already import from here, avoiding
 * a new module or a cross-tool dependency.
 */
export function countLines(str: string): number {
  let count = 1;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * Type guard: checks whether an unknown error value has a string `code`
 * property, as used by Node.js system errors (ENOENT, EACCES, etc.).
 *
 * Narrows the type so callers can access `.code` directly without unsafe
 * `as NodeJS.ErrnoException` casts. Replaces 5+ scattered inline casts
 * across loop.ts, grep.ts, bash.ts, config.ts, and index.ts.
 *
 * @example
 * ```ts
 * if (hasErrnoCode(err)) {
 *   console.log(err.code); // safely narrowed to string
 * }
 * ```
 */
export function hasErrnoCode(err: unknown): err is { code: string } {
  return (
    err != null &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}

/**
 * Type guard: checks whether an unknown error value has a truthy boolean
 * `killed` property, as set by Node.js when a child process is killed
 * due to `timeout` or `maxBuffer` being exceeded in `execFile()`.
 *
 * Replaces the unsafe `(err as { killed?: boolean }).killed` cast in
 * grep.ts with a proper type narrowing guard, consistent with the
 * `hasErrnoCode` pattern used throughout the codebase.
 */
export function hasKilledFlag(err: unknown): err is { killed: boolean } {
  return (
    err != null &&
    typeof err === "object" &&
    "killed" in err &&
    (err as { killed: unknown }).killed === true
  );
}
