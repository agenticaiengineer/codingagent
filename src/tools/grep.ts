import { execFile } from "child_process";
import { statSync } from "fs";
import { resolve } from "path";
import type { Tool, ToolInput, ToolContext, ToolResult } from "../core/types.js";
import { requireString, optionalString, optionalInteger, optionalBool, ToolInputError, hasErrnoCode, hasKilledFlag, safeTruncate } from "./validate.js";

/** Maximum time (ms) to wait for ripgrep before killing the process. */
const RG_TIMEOUT_MS = 30_000;

function runRg(
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise) => {
    // Declare abortHandler before the execFile callback so it's in scope
    // when the callback references it for removeEventListener cleanup.
    // Previously, abortHandler was defined AFTER the execFile call, relying
    // on JavaScript's closure semantics (the callback isn't invoked until
    // after the variable is assigned). While this works in practice because
    // execFile callbacks are always asynchronous, it's fragile: the variable
    // is in the Temporal Dead Zone (TDZ) during the synchronous portion of
    // the execFile call, and if the callback were ever invoked synchronously
    // (e.g., by a mock in tests, or a future Node.js change), accessing
    // `abortHandler` before its `const` declaration would throw a
    // ReferenceError. Declaring as `let` and assigning after proc is created
    // eliminates the TDZ hazard — if the callback runs before assignment,
    // `abortHandler` is `undefined`, and `removeEventListener(undefined)`
    // is a harmless no-op.
    let abortHandler: (() => void) | undefined;

    const proc = execFile("rg", args, { cwd, maxBuffer: 1024 * 1024, timeout: RG_TIMEOUT_MS }, (err, stdout, stderr) => {
      // Clean up the abort listener now that the process has exited
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);

      // Detect user-initiated abort (Ctrl+C) — report cleanly, not as error
      if (signal?.aborted) {
        resolvePromise({
          stdout: stdout || "",
          stderr: "Aborted by user.",
          exitCode: 2,
        });
        return;
      }
      // Detect ripgrep not installed (ENOENT) or not executable (EACCES)
      if (err && hasErrnoCode(err) && err.code === "ENOENT") {
        resolvePromise({
          stdout: "",
          stderr: 'ripgrep (rg) is not installed or not in PATH. Install it with:\n  • Windows: winget install BurntSushi.ripgrep.MSVC\n  • macOS: brew install ripgrep\n  • Linux: apt install ripgrep',
          exitCode: 2,
        });
        return;
      }
      // EACCES on the execFile callback means the `rg` binary was found in
      // PATH but the current user lacks execute permission on it. Without
      // this check, the error falls through to the generic "ripgrep error
      // (exit N)" path, producing a confusing message with no indication
      // that the binary exists but isn't executable. This is distinct from
      // the EACCES check for the search *path* (lines 175-180 below), which
      // catches permission errors on the directory being searched, not on
      // the ripgrep binary itself. Common causes: manually installed rg with
      // wrong permissions (e.g., `cp` instead of `install`), or a system
      // where the binary's permissions were changed by a package manager bug.
      if (err && hasErrnoCode(err) && err.code === "EACCES") {
        resolvePromise({
          stdout: "",
          stderr: 'ripgrep (rg) was found but is not executable (permission denied). Fix with:\n  • chmod +x $(which rg)\n  • Or reinstall: apt install --reinstall ripgrep',
          exitCode: 2,
        });
        return;
      }
      if (err && err.message?.includes("maxBuffer")) {
        resolvePromise({
          stdout: stdout || "",
          stderr: "Output exceeded 1 MB buffer. Use head_limit, glob, or a more specific pattern to narrow results.",
          exitCode: 2,
        });
        return;
      }
      // Detect timeout — Node sets `err.killed` when the process is killed
      // due to the `timeout` option being exceeded.
      if (hasKilledFlag(err)) {
        resolvePromise({
          stdout: stdout || "",
          stderr: `ripgrep timed out after ${RG_TIMEOUT_MS / 1000}s. Try a more specific pattern, a narrower path, or use the glob parameter to limit the file set.`,
          exitCode: 2,
        });
        return;
      }
      // Use the actual exit code from the process when available
      const exitCode = proc.exitCode ?? (err ? 1 : 0);
      resolvePromise({ stdout: stdout || "", stderr: stderr || "", exitCode });
    });

    // Forward abort signal to kill the ripgrep process. Without this,
    // pressing Ctrl+C leaves ripgrep running until its timeout (30s).
    abortHandler = () => {
      try { proc.kill("SIGTERM"); } catch { /* already exited */ }
    };
    if (signal) {
      if (signal.aborted) {
        // Already aborted before we started — kill immediately
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }
  });
}

export const grepTool: Tool = {
  name: "Grep",
  description:
    "Search tool built on ripgrep. Supports regex, file type filtering, context lines, and multiple output modes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "The regex pattern to search for",
      },
      path: {
        type: "string",
        description: "File or directory to search in. Defaults to cwd.",
      },
      glob: {
        type: "string",
        description: 'Glob pattern to filter files (e.g. "*.js")',
      },
      type: {
        type: "string",
        description: 'File type to search (e.g. "js", "py", "ts")',
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Output mode. Defaults to files_with_matches.",
      },
      "-i": { type: "boolean", description: "Case insensitive search" },
      "-n": {
        type: "boolean",
        description: "Show line numbers (content mode only)",
      },
      "-A": {
        type: "number",
        description: "Lines after match (content mode only)",
      },
      "-B": {
        type: "number",
        description: "Lines before match (content mode only)",
      },
      "-C": { type: "number", description: "Context lines (content mode only)" },
      context: { type: "number", description: "Alias for -C" },
      multiline: {
        type: "boolean",
        description: "Enable multiline matching",
      },
      head_limit: {
        type: "number",
        description: "Limit output to first N entries",
      },
    },
    required: ["pattern"],
  },
  isConcurrencySafe: true,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    try {
      const pattern = requireString(input, "pattern");

      // Reject whitespace-only patterns. `requireString` rejects empty strings,
      // but `"  "` or `"\t"` pass through and become valid ripgrep patterns that
      // match every line containing whitespace — producing massive output (every
      // line of every file in the search path). This is almost certainly
      // unintentional: the model either forgot to fill in the pattern, or passed
      // a malformed template. A clear error lets the model self-correct instead
      // of receiving an overwhelming result set (potentially hitting the 1 MB
      // maxBuffer limit) and having to re-run with a proper pattern.
      if (!/\S/.test(pattern)) {
        return {
          content: `Error: pattern contains only whitespace, which would match nearly every line. Provide a meaningful search pattern.`,
          is_error: true,
        };
      }

      const pathInput = optionalString(input, "path");
      const searchPath = pathInput
        ? resolve(context.cwd, pathInput)
        : context.cwd;

      // Pre-validate that the search path exists before spawning ripgrep.
      // Without this, a nonexistent `path` (e.g., a typo like "scr/" instead
      // of "src/", or a deleted directory) causes ripgrep to exit with code 2
      // and a confusing stderr like "No such file or directory (os error 2)".
      // A pre-check gives a clear, actionable error immediately — the LLM can
      // self-correct the path without waiting for the ripgrep subprocess to
      // start and fail. Only validate when the user explicitly provided a path;
      // the default (context.cwd) is assumed valid.
      if (pathInput) {
        try {
          statSync(searchPath);
        } catch (pathErr: unknown) {
          if (hasErrnoCode(pathErr) && pathErr.code === "ENOENT") {
            return {
              content: `Error: Search path does not exist: ${searchPath}\n\nCheck the path for typos. Use Glob to find the correct path, or omit the path parameter to search the current working directory.`,
              is_error: true,
            };
          }
          if (hasErrnoCode(pathErr) && (pathErr.code === "EACCES" || pathErr.code === "EPERM")) {
            return {
              content: `Error: Permission denied accessing search path: ${searchPath}\n\nThe current user does not have access to this directory. Use Bash with "ls -la" to check permissions.`,
              is_error: true,
            };
          }
          // Other stat errors (ELOOP, ENAMETOOLONG, etc.) — fall through
          // to let ripgrep handle them, as it may produce a better error.
        }
      }

      const outputMode = optionalString(input, "output_mode") ?? "files_with_matches";

      // Validate output_mode — an unrecognized value (e.g., "matches", "lines")
      // would silently fall through without adding -l or -c, running ripgrep in
      // its default content mode and returning unexpected results.
      const VALID_OUTPUT_MODES = ["content", "files_with_matches", "count"] as const;
      if (!(VALID_OUTPUT_MODES as readonly string[]).includes(outputMode)) {
        return {
          content: `Error: Invalid output_mode "${outputMode}". Supported modes: ${VALID_OUTPUT_MODES.join(", ")}`,
          is_error: true,
        };
      }

      const caseInsensitive = optionalBool(input, "-i");
      const showLineNumbers = optionalBool(input, "-n");
      const linesAfter = optionalInteger(input, "-A");
      const linesBefore = optionalInteger(input, "-B");
      const contextLinesC = optionalInteger(input, "-C");
      const contextAlias = optionalInteger(input, "context");
      const multiline = optionalBool(input, "multiline");
      const globPattern = optionalString(input, "glob");
      const fileType = optionalString(input, "type");
      const headLimit = optionalInteger(input, "head_limit");

      // Validate that context line counts are non-negative. Negative values
      // are semantically meaningless and ripgrep rejects them with a confusing
      // error like "invalid value '-1' for '--after-context <NUM>'".
      if (linesAfter != null && linesAfter < 0) {
        return {
          content: `Error: -A (lines after) must be non-negative, got ${linesAfter}`,
          is_error: true,
        };
      }
      if (linesBefore != null && linesBefore < 0) {
        return {
          content: `Error: -B (lines before) must be non-negative, got ${linesBefore}`,
          is_error: true,
        };
      }
      if (contextLinesC != null && contextLinesC < 0) {
        return {
          content: `Error: -C (context lines) must be non-negative, got ${contextLinesC}`,
          is_error: true,
        };
      }
      if (contextAlias != null && contextAlias < 0) {
        return {
          content: `Error: context (alias for -C) must be non-negative, got ${contextAlias}`,
          is_error: true,
        };
      }

      // Validate head_limit is a positive integer when provided.  Zero or
      // negative values are meaningless ("limit to the first 0 results")
      // and would previously be silently ignored by the `> 0` guard in the
      // truncation logic, returning all results — confusing the model into
      // thinking the limit was applied when it wasn't.
      if (headLimit != null && headLimit <= 0) {
        return {
          content: `Error: head_limit must be a positive integer, got ${headLimit}. Use head_limit to restrict output to the first N matches.`,
          is_error: true,
        };
      }

      // Validate the regex pattern before spawning ripgrep. An invalid pattern
      // (e.g., unmatched `[`, `(`, or `{`) causes ripgrep to emit a confusing
      // error like "regex parse error: ... unclosed group" that the LLM can't
      // easily interpret. Pre-validating with JavaScript's RegExp constructor
      // gives a clearer "Invalid regex" message that helps the model self-correct.
      // Note: ripgrep uses the Rust `regex` crate which has slightly different
      // syntax from JavaScript RegExp (e.g., `\p{L}` Unicode properties), so
      // some patterns valid in ripgrep may fail here. We try both with and
      // without the `u` flag: `\p{L}` is valid in JS RegExp with the `u` flag,
      // and patterns rejected by both are likely truly malformed. If a pattern
      // passes either check, we let it through to ripgrep.
      {
        let jsValid = false;
        try {
          new RegExp(pattern);
          jsValid = true;
        } catch {
          // Try with the `u` (Unicode) flag — patterns like `\p{L}`, `\p{N}`,
          // `\p{Script=Greek}` are valid in both ripgrep and JS-with-`u`, but
          // throw without the `u` flag. Without this second attempt, the
          // pre-validation would reject valid Unicode property escapes that
          // ripgrep handles natively.
          try {
            new RegExp(pattern, "u");
            jsValid = true;
          } catch { /* still invalid */ }
        }
        if (!jsValid) {
          // Check if this looks like a ripgrep-specific pattern (e.g., features
          // supported by the Rust regex crate but not by JS). If so, skip the
          // pre-validation and let ripgrep handle it — its error message will be
          // shown via the normal error path (exit code 2).
          //
          // Patterns detected:
          //   \p{L}, \P{N}       — Unicode property escapes (handled by `u` flag
          //                        fallback above, but \p{Script=Greek} etc. may not)
          //   (?x..., (?i...     — inline flag groups (only some work in JS)
          //   (?-i), (?-s)       — inline flag *negation* (not supported in JS at all)
          //   \A, \z             — Rust-specific anchors (start/end of input, distinct
          //                        from ^ and $ which are line-level in multiline mode)
          //   \b{word}           — Unicode word boundary (Rust regex crate extension)
          //   \K                 — match reset (keep left side out of match result).
          //                        Very common in grep patterns like `foo\Kbar` to
          //                        match "bar" only when preceded by "foo". Supported
          //                        by Rust regex crate but not by JS RegExp.
          //   (?>...)            — atomic groups (no backtracking into the group).
          //                        Supported by Rust regex crate but not JS RegExp.
          //   (?P<name>...)      — Python/Rust named capture group syntax. JS uses
          //                        `(?<name>...)` instead (no `P`). ripgrep accepts
          //                        both syntaxes. Without this, patterns like
          //                        `(?P<version>\d+\.\d+)` are rejected with "Invalid
          //                        regex" even though ripgrep handles them natively.
          //                        The LLM frequently uses this syntax when it has
          //                        seen Python regex examples in the codebase.
          //   (?P=name)          — Python/Rust backreference to a named group.
          //                        The JS equivalent is `\k<name>`.
          const maybeRustSpecific = /\\[pP]\{|\(\?-?[xsiamJ]|\(\?-[xsim]\)|\\[Az]|\\b\{|\\K|\(\?>|\(\?P[<=]/.test(pattern);
          if (!maybeRustSpecific) {
            const reason = (() => {
              try { new RegExp(pattern); } catch (e) { return e instanceof Error ? e.message : String(e); }
              try { new RegExp(pattern, "u"); } catch (e) { return e instanceof Error ? e.message : String(e); }
              return "unknown error";
            })();
            return {
              content: `Error: Invalid regex pattern. ${reason}\n\nTip: If you're searching for a literal string, escape special regex characters like . * + ? [ ] ( ) { } ^ $ | \\`,
              is_error: true,
            };
          }
        }
      }

      const args: string[] = [];

      // Output mode
      if (outputMode === "files_with_matches") {
        args.push("-l");
      } else if (outputMode === "count") {
        args.push("-c");
      }

      // Options
      if (caseInsensitive) args.push("-i");
      if (outputMode === "content") {
        if (showLineNumbers !== false) args.push("-n");
        // Use != null instead of truthiness to allow 0 as a valid value.
        // E.g., `-A: 0` explicitly means "no lines after", which ripgrep
        // accepts and treats differently from omitting the flag entirely.
        if (linesAfter != null) args.push("-A", String(linesAfter));
        if (linesBefore != null) args.push("-B", String(linesBefore));
        const contextLines = contextLinesC ?? contextAlias;
        if (contextLines != null) args.push("-C", String(contextLines));
      }
      if (multiline) args.push("-U", "--multiline-dotall");
      if (globPattern) args.push("--glob", globPattern);
      if (fileType) args.push("--type", fileType);

      // In content mode with head_limit, pass --max-count to ripgrep to tell
      // it to stop searching each file after N matches. This is a performance
      // optimization, not an exact limit — `--max-count` caps matches *per
      // file*, not globally. If 10 files each have many matches and
      // head_limit=5, ripgrep returns up to 5 × 10 = 50 matches, which are
      // then further trimmed to 5 by the JavaScript head_limit logic below.
      // Without this, ripgrep processes every file to completion and the
      // output is only truncated in JavaScript — wasteful for broad patterns
      // on large repos where the first few matches suffice. In
      // files_with_matches mode (-l), ripgrep already stops at the first
      // match per file (implicit --max-count=1), so this only helps content
      // mode. In count mode (-c), --max-count would change the semantics
      // (reporting the capped count per file, not the true count).
      if (headLimit != null && outputMode === "content") {
        args.push("--max-count", String(headLimit));
      }

      // Ignore common noise directories (VCS metadata, dependencies) by default.
      // However, skip these exclusions when the user explicitly provided a path
      // that is inside one of these directories (e.g., `path: "node_modules/lodash"`).
      // Without this check, `--glob "!node_modules"` causes ripgrep to
      // exclude ALL files under the user-specified path, returning zero
      // matches with no explanation — the user explicitly asked to search
      // there but the hardcoded exclusion silently overrides their intent.
      // We check both the raw `pathInput` string (before resolution) for
      // simple prefix matching, and the resolved `searchPath` for cases
      // where the user provided an absolute path.
      const isInsideExcludedDir = pathInput
        ? /(?:^|[\\/])(?:node_modules|\.git|\.hg|\.svn)(?:[\\/]|$)/.test(pathInput)
        : false;
      if (!isInsideExcludedDir) {
        args.push("--glob", "!node_modules", "--glob", "!.git", "--glob", "!.hg", "--glob", "!.svn");
      }

      args.push("--", pattern, searchPath);

      // Check if the user has already aborted (Ctrl+C) before spawning the
      // ripgrep subprocess. Without this, the abort is only detected after
      // execFile returns (either via the `signal?.aborted` check inside runRg
      // or the post-runRg abort check below). In the interim, execFile spawns
      // a process, allocates stdout/stderr buffers, and waits for the process
      // to start — all wasted work when the result will be discarded. This is
      // the same pre-spawn abort check pattern used in bash.ts and task.ts.
      if (context.abortController.signal.aborted) {
        return { content: "Aborted by user.", is_error: true };
      }

      const { stdout, stderr, exitCode } = await runRg(args, context.cwd, context.abortController.signal);

      // Check for user-initiated abort after runRg returns. When Ctrl+C fires,
      // runRg returns { exitCode: 2, stderr: "Aborted by user." } — but exit
      // code 2 also means a genuine ripgrep error (invalid file type, permission
      // denied, etc.). Without this check, the abort case falls through to the
      // `exitCode !== 0 && exitCode !== 1` branch and produces the confusing
      // message "ripgrep error (exit 2): Aborted by user." — making it look
      // like ripgrep failed rather than the user intentionally cancelling. The
      // same pattern is used in glob.ts (post-scan abort check) and bash.ts
      // (pre-spawn abort check).
      if (context.abortController.signal.aborted) {
        return { content: "Aborted by user.", is_error: true };
      }

      if (exitCode === 1) {
        // Include the search path and actionable suggestions so the user
        // (and the LLM) can self-correct. Without suggestions, the model
        // tends to retry the exact same search or give up. Common reasons
        // for zero matches: wrong case, overly specific pattern, wrong
        // directory, or the file type filter excluding relevant files.
        const suggestions: string[] = [];
        if (!caseInsensitive) {
          suggestions.push("try case-insensitive search (-i: true)");
        }
        if (fileType) {
          suggestions.push(`remove or change the file type filter (currently: "${fileType}")`);
        }
        if (globPattern) {
          suggestions.push(`widen the glob filter (currently: "${globPattern}")`);
        }
        if (pathInput) {
          suggestions.push("verify the search path or omit it to search the full working directory");
        }
        const hintsStr = suggestions.length > 0
          ? `\nSuggestions: ${suggestions.join("; ")}.`
          : "";
        return { content: `No matches found for pattern "${pattern}" in ${searchPath}.${hintsStr}` };
      }
      if (exitCode !== 0 && exitCode !== 1) {
        // Detect unrecognized file type errors. When the user passes a type
        // like "tsx", "jsx", "vue", or "svelte" that ripgrep doesn't have a
        // built-in definition for, ripgrep exits with code 2 and a message
        // like "Unrecognized file type: tsx". The raw error message tells the
        // user to run `rg --type-list` — unhelpful for an LLM that can't
        // interactively run commands. Instead, suggest the common fix: use a
        // glob pattern (e.g., `glob: "*.tsx"`) which achieves the same effect
        // without requiring a built-in type definition. Also suggest the
        // correct built-in name when there's an obvious mapping (e.g., "tsx"
        // and "jsx" are included under ripgrep's "ts" and "js" types).
        if (stderr.includes("Unrecognized file type")) {
          // Common type aliases that the LLM frequently guesses wrong.
          // Ripgrep's "ts" type includes *.ts and *.tsx; "js" includes *.js
          // and *.jsx; "py" includes *.py, *.pyi, etc. The LLM often passes
          // the file extension as the type, which doesn't match ripgrep's
          // type name conventions.
          const TYPE_SUGGESTIONS: Record<string, string> = {
            tsx: 'Use type: "ts" (includes *.ts and *.tsx) or glob: "*.tsx"',
            jsx: 'Use type: "js" (includes *.js and *.jsx) or glob: "*.jsx"',
            yml: 'Use type: "yaml" or glob: "*.yml"',
            mjs: 'Use type: "js" or glob: "*.mjs"',
            cjs: 'Use type: "js" or glob: "*.cjs"',
            mts: 'Use type: "ts" or glob: "*.mts"',
            cts: 'Use type: "ts" or glob: "*.cts"',
            htm: 'Use type: "html" or glob: "*.htm"',
            dockerfile: 'Use glob: "Dockerfile*"',
            makefile: 'Use type: "make" or glob: "Makefile*"',
          };
          const suggestion = fileType ? TYPE_SUGGESTIONS[fileType.toLowerCase()] : undefined;
          const hint = suggestion
            ? `\n\n${suggestion}`
            : `\n\nTip: Use a glob pattern instead (e.g., glob: "*.${fileType ?? "ext"}") to match files by extension without needing a built-in type definition.`;
          return {
            content: `Error: ${stderr.trim()}${hint}`,
            is_error: true,
          };
        }
        return {
          content: `ripgrep error (exit ${exitCode}): ${stderr}`,
          is_error: true,
        };
      }

      let output = stdout.trim();

      // Apply head_limit — limit to first N logical entries.
      // In files_with_matches and count modes, each line is one entry.
      // In content mode with context lines (-A/-B/-C), entries are separated
      // by "--" lines, so we split on that separator to count correctly.
      // In content mode WITHOUT context lines, ripgrep emits one line per
      // match with no "--" separators, so we fall back to line-based splitting.
      //
      // Note: in content mode, ripgrep's --max-count already capped matches
      // per file (not globally), so the total count here may be lower than the
      // true total. The truncation message uses "≥" to signal this is a lower
      // bound, not the true match count.
      if (headLimit != null && headLimit > 0) {
        if (outputMode === "content") {
          // Check whether the output contains "--" entry separators (added
          // by ripgrep when -A/-B/-C context lines are used).
          const hasContextSeparators = output.includes("\n--\n");
          if (hasContextSeparators) {
            // Content mode with context: entries are delimited by "\n--\n"
            const entries = output.split("\n--\n");
            if (entries.length > headLimit) {
              output = entries.slice(0, headLimit).join("\n--\n") +
                `\n... (limited to first ${headLimit} of ≥${entries.length} entries)`;
            }
          } else {
            // Content mode without context lines: each output line is one
            // match (e.g., "file:42:matched text"). Without this fallback,
            // `split("\n--\n")` returns a single entry containing ALL matches,
            // making head_limit ineffective — `1 > headLimit` is always false
            // for any reasonable headLimit value.
            const lines = output.split("\n");
            if (lines.length > headLimit) {
              output = lines.slice(0, headLimit).join("\n") +
                `\n... (limited to first ${headLimit} of ≥${lines.length} matches)`;
            }
          }
        } else {
          // files_with_matches / count: each line is one entry
          const lines = output.split("\n");
          if (lines.length > headLimit) {
            output = lines.slice(0, headLimit).join("\n") +
              `\n... (limited to first ${headLimit} of ${lines.length} entries)`;
          }
        }
      }

      // Truncate very large output using the shared safeTruncate() helper
      // which avoids splitting a UTF-16 surrogate pair into a lone high
      // surrogate (malformed Unicode) at the cut point.
      if (output.length > 30000) {
        output = safeTruncate(output, 30000) + "\n... (output truncated)";
      }

      return { content: output || `No matches found for pattern "${pattern}" in ${searchPath}.` };
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      // Include the pattern and search path in the error message so the model
      // can identify which Grep call failed when multiple run in parallel (the
      // model receives multiple tool_result blocks correlated only by tool_use_id).
      // Previously the error was just "Error running grep: <message>" with no
      // context — if three Grep calls were in flight and one failed, the model
      // couldn't tell which pattern/path to retry or debug. Access `input.pattern`
      // and `input.path` directly from the function parameter since the `const`
      // variables declared inside the try block are out of scope here. Use
      // String() guard + safeTruncate to handle non-string values and prevent
      // a long hallucinated pattern from bloating the error message.
      const msg = err instanceof Error ? err.message : String(err);
      const errPattern = typeof input.pattern === "string"
        ? safeTruncate(input.pattern, 100)
        : "(unknown pattern)";
      const errPath = typeof input.path === "string"
        ? input.path
        : "(cwd)";
      return { content: `Error running grep for pattern "${errPattern}" in ${errPath}: ${msg}`, is_error: true };
    }
  },
};
