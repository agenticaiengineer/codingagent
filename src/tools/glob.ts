import { glob } from "glob";
import { statSync, lstatSync } from "fs";
import { resolve } from "path";
import type { Tool, ToolInput, ToolContext, ToolResult } from "../core/types.js";
import { requireString, optionalString, ToolInputError, hasErrnoCode, safeTruncate } from "./validate.js";

/** Maximum time (ms) to wait for glob before aborting. */
const GLOB_TIMEOUT_MS = 30_000;

/**
 * Maximum output size (characters) before truncation. Matches the cap used
 * by grep.ts and bash.ts. Without this, 500 file paths with long absolute
 * paths can produce 50+ KB of text dumped into the conversation context,
 * consuming tokens and potentially triggering auto-compaction prematurely.
 */
const OUTPUT_CHAR_CAP = 30_000;

/**
 * Check for abort every N files during the mtime stat loop. On slow
 * filesystems (NFS, SSHFS) each statSync can take 10–50ms, so checking
 * every 50 files gives ~0.5–2.5s worst-case abort latency while avoiding
 * the overhead of checking the signal on every single syscall.
 */
const ABORT_CHECK_INTERVAL = 50;

export const globTool: Tool = {
  name: "Glob",
  description:
    "Fast file pattern matching tool. Supports glob patterns like '**/*.js' or 'src/**/*.ts'. Returns matching file paths sorted by modification time. Note: '*' and '**' do not match dotfiles/dotdirs (e.g., .env, .gitignore, .github/) unless the pattern explicitly targets them with a dot prefix (e.g., '**/.*', '**/.env', '**/.[eg]*').",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match files against",
      },
      path: {
        type: "string",
        description:
          "The directory to search in. Defaults to current working directory.",
      },
    },
    required: ["pattern"],
  },
  isConcurrencySafe: true,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    try {
      const pattern = requireString(input, "pattern");

      // Reject whitespace-only patterns. `requireString` rejects empty strings
      // but accepts `"   "` or `"\n\t"`, which would be passed to the glob
      // library and silently return zero matches — the model sees "No files
      // matched" and wastes turns trying different patterns when the real issue
      // is a blank pattern. This matches the same whitespace-only rejection
      // already applied in grep.ts (pattern), bash.ts (command), task.ts
      // (prompt), and web.ts (query).
      if (pattern.trim().length === 0) {
        return {
          content: 'Error: Glob pattern is empty (whitespace only). Provide a file pattern like "**/*.ts" or "src/**/*.js".',
          is_error: true,
        };
      }

      const pathInput = optionalString(input, "path");
      const searchPath = pathInput
        ? resolve(context.cwd, pathInput)
        : context.cwd;

      // Check for abort before starting a potentially expensive glob scan
      if (context.abortController.signal.aborted) {
        return { content: "Aborted by user.", is_error: true };
      }

      // Pre-validate that the search path exists before starting the glob scan.
      // Without this, a nonexistent `path` (e.g., a typo like "scr/" instead of
      // "src/") causes the glob library to silently return zero matches — the
      // model sees "No files matched the pattern" and wastes turns trying
      // different patterns when the real issue is the path. Matching the same
      // pre-validation pattern already used in grep.ts (lines 165-184). Only
      // validate when the user explicitly provided a path; the default
      // (context.cwd) is assumed valid.
      if (pathInput) {
        try {
          const pathStat = statSync(searchPath);
          if (!pathStat.isDirectory()) {
            return {
              content: `Error: Search path is not a directory: ${searchPath}\n\nGlob searches directories for file patterns. If you want to read a specific file, use the Read tool instead.`,
              is_error: true,
            };
          }
        } catch (pathErr: unknown) {
          if (hasErrnoCode(pathErr) && pathErr.code === "ENOENT") {
            return {
              content: `Error: Search path does not exist: ${searchPath}\n\nCheck the path for typos. Use Glob with a broader pattern or omit the path parameter to search the current working directory.`,
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
          // to let the glob library handle them.
        }
      }

      /**
       * Get the modification time of a file path, with a fallback for
       * dangling symlinks. `statSync` follows symlinks and throws ENOENT
       * if the target doesn't exist; `lstatSync` stats the symlink itself,
       * so we still get a usable mtime for sorting rather than sorting
       * dangling symlinks to the bottom (mtimeMs = 0).
       */
      function getFileMtimeMs(filePath: string): number {
        try {
          return statSync(filePath).mtimeMs;
        } catch {
          try {
            return lstatSync(filePath).mtimeMs;
          } catch {
            return 0; // File deleted between glob and stat — sort it last
          }
        }
      }

      // Create a combined abort signal that fires on either user abort (Ctrl+C)
      // or a timeout. Unlike grep.ts (which uses execFile's built-in timeout),
      // the glob library only accepts an AbortSignal, so we need to manage the
      // timeout ourselves. Without this, a glob like `**/*` on a deep filesystem
      // with millions of files could run for minutes with no way to stop it.
      const timeoutController = new AbortController();
      const timeoutTimer = setTimeout(() => {
        timeoutController.abort();
      }, GLOB_TIMEOUT_MS);
      // Prevent the timeout timer from keeping the Node.js process alive
      // during shutdown. Without unref(), if the user exits (Ctrl+C twice,
      // /quit, or SIGTERM) while a glob scan is running, the 30-second
      // timeout timer keeps the event loop alive — the process hangs for up
      // to 30 seconds after the user requested an exit. The same pattern is
      // used in bash.ts (line ~246), retry.ts (line ~173), and ui.ts (spinner).
      timeoutTimer.unref();
      // Propagate user abort to the timeout controller
      const userAbortHandler = () => timeoutController.abort();
      context.abortController.signal.addEventListener("abort", userAbortHandler, { once: true });

      // Auto-detect whether the pattern targets dotfiles/dotdirs and enable
      // `dot: true` automatically. Previously `dot` was always `false`, and
      // patterns like `.env`, `**/.github/**`, or `.*` would silently return
      // zero results — the glob engine skips hidden entries by default. The
      // user would get a suggestion to use `find` or `ls -a` instead, but
      // there's no reason the Glob tool itself can't handle these patterns.
      //
      // This covers the most common dotfile patterns:
      //   - Patterns with a dotfile component: `.env`, `**/.github/**`, `**/.eslintrc*`
      //   - Bare dotglobs: `.*`, `**/.*`
      //   - Patterns starting with a dot: `.gitignore`, `.github/workflows/*.yml`
      //   - Brace expansions targeting dotfiles: `.{env,gitignore}`, `**/.{env,env.local}`
      //   - Dotfiles starting with digits: `.1password`, `.0rc`
      const patternLower = pattern.toLowerCase();
      const targetsDotfiles =
        // Component starting with dot + letter, digit, or brace expansion.
        // The previous regex only matched dot + `[a-z]`, missing:
        //   - `.{env,gitignore}` — dot + `{` (brace expansion targeting dotfiles)
        //   - `.1password`, `.0rc` — dot + digit (rare but valid)
        // The expanded character class `[a-z0-9{_]` covers these cases while
        // still excluding `./` (current directory), `..` (parent directory),
        // and lone dots that aren't dotfile patterns.
        /(?:^|\/)\.[a-z0-9{_]/.test(patternLower) || // component starting with dot + word char or brace
        patternLower === ".*" ||                  // bare .*
        patternLower === "**/.*";                 // **/.* 
      const useDot = targetsDotfiles;

      // Skip VCS/dependency exclusions when the user explicitly asked to
      // search inside one of those directories (same logic applied in grep.ts).
      // Without this, `glob("**/*.js", {path: "node_modules/my-lib"})` returns
      // zero results because the ignore list rejects everything under node_modules.
      const isInsideExcludedDir = pathInput
        ? /(?:^|[\\/])(?:node_modules|\.git|\.hg|\.svn)(?:[\\/]|$)/.test(pathInput)
        : false;

      let matches: string[];
      try {
        matches = await glob(pattern, {
          cwd: searchPath,
          nodir: true,
          dot: useDot,
          ignore: isInsideExcludedDir ? [] : ["**/node_modules/**", "**/.git/**", "**/.hg/**", "**/.svn/**"],
          absolute: true,
          signal: timeoutController.signal,
        });
      } catch (globErr: unknown) {
        // Distinguish timeout from user abort
        if (context.abortController.signal.aborted) {
          return { content: "Aborted by user.", is_error: true };
        }
        if (timeoutController.signal.aborted) {
          return {
            content: `Glob timed out after ${GLOB_TIMEOUT_MS / 1000}s. Try a more specific pattern or a narrower path to reduce the search scope.`,
            is_error: true,
          };
        }
        throw globErr; // re-throw unexpected errors
      } finally {
        clearTimeout(timeoutTimer);
        context.abortController.signal.removeEventListener("abort", userAbortHandler);
      }

      if (matches.length === 0) {
        // If the user's pattern doesn't target dotfiles but they might have
        // intended to search hidden files, provide a helpful hint.
        if (!useDot) {
          return {
            content: `No files matched the pattern "${pattern}" in ${searchPath}. Note: dotfiles/dotdirs (e.g., .env, .github/) are excluded by default. To include them, use a pattern with an explicit dot prefix (e.g., '**/.*', '**/.env').`,
          };
        }
        // Provide a platform-appropriate alternative suggestion. On Windows,
        // `find` is a completely different command (file name search, not Unix
        // find) and `ls -a` doesn't exist without Git Bash/WSL. Suggesting
        // Unix-specific tools confuses users and wastes a model turn trying
        // non-existent commands. On macOS/Linux, traditional Unix tools work.
        const altToolHint = process.platform === "win32"
          ? ` Try using Bash with "dir /a" or "Get-ChildItem -Force" (PowerShell) to list hidden files, or verify the search path.`
          : ` Try using Bash with "find" or "ls -la" to verify the directory contents, or check the path for typos.`;
        return { content: `No files matched the pattern "${pattern}" in ${searchPath}.${altToolHint}` };
      }

      // Check for abort after the glob scan completes but before the
      // expensive mtime stat calls. A glob like `**/*.ts` on a large
      // codebase may return thousands of matches, and statSync-ing each
      // one takes significant time. If the user pressed Ctrl+C during
      // the glob scan, the abort signal is already set — proceeding to
      // stat hundreds of files wastes time and delays the abort response.
      if (context.abortController.signal.aborted) {
        return { content: "Aborted by user.", is_error: true };
      }

      // If we have more matches than the limit, we can't sort all of them
      // by mtime efficiently (each requires a syscall). For large result sets,
      // truncate first and sort the limited set. For manageable result sets
      // (≤ 500), sort fully by mtime.
      const LIMIT = 500;

      if (matches.length <= LIMIT) {
        // Sort all by modification time (newest first).
        // Check for abort every ABORT_CHECK_INTERVAL files so Ctrl+C is
        // responsive even on slow filesystems (NFS, SSHFS) where each
        // statSync can take tens of milliseconds. Without this, the user
        // must wait for all 500 stat calls to complete before abort is
        // detected — potentially 5+ seconds on network filesystems.
        const withMtime: Array<{ path: string; mtimeMs: number }> = [];
        for (let i = 0; i < matches.length; i++) {
          if (i > 0 && i % ABORT_CHECK_INTERVAL === 0 && context.abortController.signal.aborted) {
            return { content: "Aborted by user.", is_error: true };
          }
          withMtime.push({
            path: matches[i],
            mtimeMs: getFileMtimeMs(matches[i]),
          });
        }

        withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

        // Prepend the match count so the model knows how many results it got
        // without counting lines. The >LIMIT path (line ~277) already includes
        // a count in its suffix, but the ≤LIMIT path was missing one — the
        // model had to count lines manually to determine the result set size,
        // which is error-prone (especially when paths contain spaces or are
        // truncated). This is especially valuable for "how many files match?"
        // type queries where the count is the primary information.
        let content = `Found ${withMtime.length} file${withMtime.length !== 1 ? "s" : ""} (sorted by modification time, newest first)\n` +
          withMtime.map((f) => f.path).join("\n");
        if (content.length > OUTPUT_CHAR_CAP) {
          content = safeTruncate(content, OUTPUT_CHAR_CAP) + "\n... (output truncated)";
        }
        return { content };
      }

      // Too many matches — truncate to LIMIT and sort the truncated set by mtime.
      // We stat only the limited set (O(LIMIT) syscalls) rather than all matches
      // (O(n) syscalls), then sort by recency so the most relevant files appear
      // first. Without this sort, the LLM sees files in arbitrary readdir order
      // and may miss recently-modified files that are most likely to be relevant.
      const limited = matches.slice(0, LIMIT);
      const limitedWithMtime: Array<{ path: string; mtimeMs: number }> = [];
      for (let i = 0; i < limited.length; i++) {
        if (i > 0 && i % ABORT_CHECK_INTERVAL === 0 && context.abortController.signal.aborted) {
          return { content: "Aborted by user.", is_error: true };
        }
        limitedWithMtime.push({
          path: limited[i],
          mtimeMs: getFileMtimeMs(limited[i]),
        });
      }
      limitedWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

      let content = limitedWithMtime.map((f) => f.path).join("\n");
      // Append the "N more matches" suffix BEFORE checking for output
      // truncation. Previously the suffix was appended AFTER the truncation
      // message, producing confusing output like:
      //   [paths]\n... (output truncated)\n... and 4500 more (showing first 500)
      // The "output truncated" message appeared mid-output instead of at the
      // end, and the two "..." lines looked like duplicated messages. Now the
      // suffix is part of the content that gets truncated, and the truncation
      // message (if needed) is always the last line — matching the pattern
      // used in the ≤LIMIT path (line ~244) and in grep.ts/bash.ts.
      content += `\n... and ${matches.length - LIMIT} more (showing first ${LIMIT} matches, sorted by modification time)`;
      if (content.length > OUTPUT_CHAR_CAP) {
        content = safeTruncate(content, OUTPUT_CHAR_CAP) + "\n... (output truncated)";
      }
      return { content };
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      // If the user aborted (Ctrl+C), report cleanly instead of as an error
      if (context.abortController.signal.aborted) {
        return { content: "Aborted by user.", is_error: true };
      }
      // Include the pattern and path in the error message so the model can
      // identify which Glob call failed when multiple run in parallel. Same
      // pattern as the improvement applied to grep.ts's catch block. Access
      // `input.pattern` and `input.path` directly from the function parameter
      // since the `const` variables are scoped to the try block. Use safeTruncate
      // on the pattern to prevent bloated error messages from hallucinated inputs.
      const msg = err instanceof Error ? err.message : String(err);
      const errPattern = typeof input.pattern === "string"
        ? safeTruncate(input.pattern, 100)
        : "(unknown pattern)";
      const errPath = typeof input.path === "string"
        ? input.path
        : "(cwd)";
      return { content: `Error in glob for pattern "${errPattern}" in ${errPath}: ${msg}`, is_error: true };
    }
  },
};
