import { readFileSync, openSync, readSync, writeSync, fstatSync, closeSync, statSync, lstatSync, realpathSync, unlinkSync } from "fs";
import { resolve, dirname, basename } from "path";
import { createTwoFilesPatch } from "diff";
import type { Tool, ToolInput, ToolContext, ToolResult } from "../core/types.js";
import { requireString, requireFilePath, optionalBool, ToolInputError, hasErrnoCode, safeTruncate, countLines } from "./validate.js";
import { atomicReplace } from "./fs-utils.js";
import { printWarning } from "../ui/ui.js";

/**
 * Maximum file size (in bytes) that the Edit tool will process.
 * Matches the 50 MB limit in read.ts.  Without this guard, editing a multi-GB
 * file would attempt to read the entire file into memory (readFileSync), perform
 * string operations on it (indexOf, replace, split/join), and generate a diff
 * — all of which can OOM the process.  The Read tool has its own limit, but Edit
 * does an independent readFileSync and nothing prevented the model from editing
 * a file it never read (if it was in readFileState from a previous session).
 */
const MAX_EDIT_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Monotonically increasing counter appended to temp file names to prevent
 * collisions when two Edit calls happen within the same millisecond.
 * `Date.now()` alone has only millisecond resolution, and `process.pid` is
 * constant — concurrent edits to different files in the same directory within
 * the same ms would produce identical temp paths, causing `openSync("wx")`
 * to fail with EEXIST. (Edit is concurrency-unsafe so this is unlikely in
 * normal operation, but the counter is cheap insurance against bugs or future
 * concurrency changes.)
 */
let tmpCounter = 0;

// Normalize curly quotes to straight quotes (matching Claude Code's behavior)
function normalizeCurlyQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

export const editTool: Tool = {
  name: "Edit",
  description:
    "Performs exact string replacements in files. old_string must be unique in the file unless replace_all is true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to modify",
      },
      old_string: {
        type: "string",
        description: "The text to replace",
      },
      new_string: {
        type: "string",
        description: "The text to replace it with",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences (default false)",
        default: false,
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  isConcurrencySafe: false,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    try {
      const filePathRaw = requireFilePath(input, "file_path");
      const oldString = requireString(input, "old_string");
      const replaceAll = optionalBool(input, "replace_all") ?? false;

      // new_string is required but may be empty (to delete text), so validate manually
      if (typeof input.new_string !== "string") {
        return {
          content: `Missing or invalid required parameter "new_string": expected a string`,
          is_error: true,
        };
      }
      let newString = input.new_string;

      // Short-circuit when old_string and new_string are identical — no file
      // I/O, mtime check, or readFileState lookup is needed. Previously this
      // check ran at line ~208 after reading the file, doing fstat, opening an
      // fd, and applying the no-op replacement — all wasted work.
      //
      // Also check line-ending-normalized equivalence: if old_string and
      // new_string differ only in \r\n vs \n (e.g., one has Windows line
      // endings and the other Unix), the CRLF normalization logic later would
      // convert both to the file's convention, making them identical — the
      // edit would produce no change but the user would get a confusing
      // "replacement produced no change" error instead of the clear
      // "identical" error. Normalizing \r\n to \n for comparison catches this
      // early with a precise error message.
      const normalizedOld = oldString.replace(/\r\n/g, "\n");
      const normalizedNew = newString.replace(/\r\n/g, "\n");
      if (oldString === newString || normalizedOld === normalizedNew) {
        return {
          content: `Error: old_string and new_string are identical${oldString !== newString ? " (after line-ending normalization)" : ""} — no changes needed for ${filePathRaw}`,
          is_error: true,
        };
      }

      const filePath = resolve(context.cwd, filePathRaw);

      // Use a single statSync in try/catch instead of existsSync + statSync.
      // The previous pattern had a TOCTOU race: the file could be deleted
      // between existsSync (returning true) and the subsequent openSync,
      // causing an unhandled error. This also eliminates a redundant syscall.
      // Same fix already applied to read.ts (improvement #25).
      let preCheckStat: ReturnType<typeof statSync>;
      try {
        preCheckStat = statSync(filePath);
      } catch (statErr: unknown) {
        if (hasErrnoCode(statErr) && statErr.code === "ENOENT") {
          return { content: `Error: File not found: ${filePath}`, is_error: true };
        }
        throw statErr; // re-throw unexpected errors (EACCES, etc.) for outer catch
      }

      // Guard against editing a directory. statSync succeeds on directories,
      // but the subsequent openSync + readFileSync would fail with a confusing
      // platform-dependent error (EISDIR on Linux, "illegal operation on a
      // directory" on macOS). Match read.ts's explicit directory check so the
      // user gets a clear, actionable error message.
      if (preCheckStat.isDirectory()) {
        return {
          content: `Error: ${filePath} is a directory, not a file. The Edit tool only works on regular files.`,
          is_error: true,
        };
      }

      // Guard against editing special files (device files, FIFOs, sockets).
      // These are not regular files — reading from a FIFO blocks until a
      // writer connects (hanging the tool), and character/block devices
      // produce raw binary data that the Edit tool can't meaningfully process.
      // Matches the same guard applied in read.ts and write.ts.
      if (!preCheckStat.isFile()) {
        const kind = preCheckStat.isCharacterDevice() ? "character device"
          : preCheckStat.isBlockDevice() ? "block device"
          : preCheckStat.isFIFO() ? "FIFO/pipe"
          : preCheckStat.isSocket() ? "socket"
          : "special file";
        return {
          content: `Error: ${filePath} is a ${kind}, not a regular file. The Edit tool only works on regular files. Use Bash to interact with special files.`,
          is_error: true,
        };
      }

      // Guard against editing extremely large files. readFileSync below
      // loads the entire file into memory, and string operations (indexOf,
      // replace, split/join) plus diff generation can temporarily use 3-4x
      // the file size. Without this check, editing a multi-GB file would
      // OOM the process or cause severe swapping.
      if (preCheckStat.size > MAX_EDIT_FILE_SIZE_BYTES) {
        const sizeMB = (preCheckStat.size / (1024 * 1024)).toFixed(1);
        return {
          content: `Error: File is too large to edit (${sizeMB} MB). Maximum supported size is ${MAX_EDIT_FILE_SIZE_BYTES / (1024 * 1024)} MB. Use Bash with sed, awk, or other stream-processing tools for large files.`,
          is_error: true,
        };
      }

      // If filePath is a symlink, resolve it to the real target path so the
      // atomic replace operates on the target file rather than replacing the
      // symlink itself with a regular file (destroying the symlink). This is
      // the same fix applied to write.ts (improvement #24). Without it,
      // `renameSync(tmp, symlinkPath)` replaces the symlink with a regular
      // file on Linux, which is almost never the user's intent — especially
      // in monorepos and plugin systems that use symlinks for local packages.
      let editPath = filePath;
      try {
        const lstat = lstatSync(filePath);
        if (lstat.isSymbolicLink()) {
          editPath = realpathSync(filePath);
        }
      } catch (lstatErr: unknown) {
        // If lstatSync fails for a non-ENOENT reason (e.g., EACCES, ELOOP),
        // log a warning so the error is visible for debugging. Previously all
        // errors were silently swallowed, making it impossible to diagnose
        // why symlink resolution failed (the edit would proceed to the
        // original path, potentially replacing the symlink with a regular
        // file instead of writing through it to the target). Same diagnostic
        // warning pattern already applied to write.ts (improvement #33).
        if (hasErrnoCode(lstatErr) && lstatErr.code !== "ENOENT") {
          const code = lstatErr.code;
          printWarning(`Could not check symlink status for ${filePath} (${code}) — proceeding with original path.`);
        }
        // Fall through with the original filePath — statSync succeeded so
        // the path is valid, just can't determine if it's a symlink.
      }

      // Must have read the file first.
      // Use `get()` directly instead of `has()` + later `get()` to avoid a
      // TOCTOU race: with a separate `has()` check, a concurrent read on
      // another file could trigger LRU eviction between `has()` and `get()`,
      // making `get()` return undefined — silently skipping the mtime check
      // and allowing a stale edit on a modified file.
      // Check both the original path and the resolved symlink target — the Read
      // tool may have recorded the state under either path depending on how the
      // user specified it (same approach as write.ts). Skip the second lookup
      // when editPath === filePath (non-symlink case) to avoid a redundant LRU
      // promotion — `get()` re-inserts entries to update recency, so calling it
      // twice on the same key wastes a delete+set cycle.
      const savedState = context.readFileState.get(filePath) ?? (editPath !== filePath ? context.readFileState.get(editPath) : undefined);
      if (!savedState) {
        return {
          content: `Error: You must read the file before editing it. Use the Read tool first on: ${filePath}`,
          is_error: true,
        };
      }

      // Read the file content and check mtime on the *same* file descriptor
      // to eliminate the TOCTOU race. Previously readFileSync and statSync
      // were two separate syscalls — if the file was modified between them,
      // we'd read content from the new version but check the mtime of an
      // even newer version, potentially missing the modification.
      // Using openSync + fstatSync on the same fd is truly atomic.
      let originalContent: string;
      let stat: { mtimeMs: number };
      let fd = openSync(filePath, "r");
      try {
        // Binary check — sample the first 8 KB for null bytes, matching the
        // approach in read.ts. Previously this scanned the ENTIRE file via
        // `originalContent.includes("\0")` after a full readFileSync, meaning
        // a 50 MB text file would allocate 50 MB and then scan all 50 MB for
        // a null byte that's almost always in the first few bytes of a binary
        // file. Sampling only the first 8 KB avoids reading the full file if
        // it's binary (we can return early), and for text files the cost of
        // the extra 8 KB readSync is negligible compared to the subsequent
        // full readFileSync.
        const BINARY_CHECK_SIZE = 8192;
        if (preCheckStat.size > 0) {
          const sampleBuf = Buffer.alloc(Math.min(preCheckStat.size, BINARY_CHECK_SIZE));
          readSync(fd, sampleBuf, 0, sampleBuf.length, 0);
          let hasNullByte = false;
          for (let i = 0; i < sampleBuf.length; i++) {
            if (sampleBuf[i] === 0) {
              hasNullByte = true;
              break;
            }
          }
          if (hasNullByte) {
            // Close the fd and mark it as closed. If closeSync throws (e.g.,
            // EIO on network-attached storage), we still set fd = -1 BEFORE
            // the throw propagates — otherwise the finally block would call
            // closeSync(fd) again. Double-close is dangerous: on some OSes
            // (Linux, macOS), the fd number may already be reused by a
            // concurrent open() in another thread/async operation, so closing
            // it again would silently close an UNRELATED file descriptor —
            // a data corruption bug that's nearly impossible to diagnose.
            // Using try/finally here ensures fd = -1 runs regardless.
            try {
              closeSync(fd);
            } finally {
              fd = -1;
            }
            return {
              content: `Error: ${filePath} appears to be a binary file. The Edit tool only supports text files.`,
              is_error: true,
            };
          }
        }

        originalContent = readFileSync(fd, "utf-8");
        stat = fstatSync(fd);
      } finally {
        if (fd !== -1) {
          try { closeSync(fd); } catch { /* already closed */ }
        }
      }
      // savedState is guaranteed non-null here (checked above), so the
      // mtime check always runs — no silent skip on LRU eviction.
      if (Math.abs(stat.mtimeMs - savedState.timestamp) > 1000) {
        return {
          content: `Error: File has been modified since last read. Re-read before editing: ${filePath}`,
          is_error: true,
        };
      }

      let content = originalContent;

      // Try exact match first, then try with line-ending normalization,
      // then try with curly-quote normalization, then try with BOTH
      // normalizations combined (for CRLF files with curly quotes).
      // `usedCurlyQuoteNorm` tracks whether we needed normalization so the
      // replace_all path can handle files with mixed curly-quote variants.
      let searchString = oldString;
      let usedCurlyQuoteNorm = false;
      // Track whether line-ending normalization was applied so we know to
      // also normalize newString if curly-quote normalization later succeeds
      // on the CRLF-adjusted string.
      let usedLineEndingNorm = false;
      if (!content.includes(searchString)) {
        // Line-ending normalization: the Read tool strips \r from \r\n line
        // endings (improvement #9), so the model sees content with \n only.
        // When it copies that text into old_string, it uses \n — but the raw
        // file content still has \r\n, causing content.includes() to fail.
        // Fix by converting \n in old_string to \r\n when the file uses \r\n.
        // Also handle the reverse case (\r\n in old_string, \n in file) for
        // robustness, since paste from Windows clipboard can introduce \r\n
        // even when editing a Unix-line-ending file.
        const fileHasCRLF = content.includes("\r\n");
        const searchHasCRLF = searchString.includes("\r\n");
        if (fileHasCRLF && !searchHasCRLF && searchString.includes("\n")) {
          // File uses \r\n but old_string uses \n — convert old_string to \r\n
          const crlfSearch = searchString.replace(/\n/g, "\r\n");
          if (content.includes(crlfSearch)) {
            searchString = crlfSearch;
            // Also convert new_string to preserve the file's \r\n convention.
            // Without this, the replacement would inject \n lines into a \r\n
            // file, creating mixed line endings.
            newString = newString.replace(/\n/g, "\r\n");
          } else {
            // CRLF conversion alone didn't match — but keep `searchString`
            // updated to the CRLF form so the subsequent curly-quote
            // normalization path can find a match when BOTH issues exist
            // simultaneously (CRLF mismatch + curly quotes). Without this,
            // curly-quote normalization would normalize the original `\n`-based
            // `searchString` while `content` has `\r\n`, causing
            // `normalizedContent.includes(normalizedSearch)` to fail because of
            // the line-ending mismatch — even though the text is semantically
            // present. The `usedLineEndingNorm` flag tracks this so `newString`
            // is also CRLF-adjusted if the combined match succeeds.
            searchString = crlfSearch;
            usedLineEndingNorm = true;
          }
        } else if (!fileHasCRLF && searchHasCRLF) {
          // File uses \n but old_string uses \r\n — strip \r from old_string
          const lfSearch = searchString.replace(/\r\n/g, "\n");
          if (content.includes(lfSearch)) {
            searchString = lfSearch;
            // Also strip \r\n from new_string to match the file's \n convention
            newString = newString.replace(/\r\n/g, "\n");
          } else {
            // Same as the CRLF branch: keep the LF-normalized form for the
            // combined CRLF + curly-quote path, and track the adjustment.
            searchString = lfSearch;
            usedLineEndingNorm = true;
          }
        }
      }
      if (!content.includes(searchString)) {
        const normalizedContent = normalizeCurlyQuotes(content);
        const normalizedSearch = normalizeCurlyQuotes(searchString);
        // Verify that normalization preserved string length — the index-based
        // substring extraction below relies on 1:1 character mapping. If a
        // future edit to normalizeCurlyQuotes breaks this invariant (e.g., by
        // adding multi-char replacements like «…» → "..."), the wrong substring
        // would be extracted from originalContent, silently corrupting the file.
        // This assertion turns a potential silent data corruption bug into a
        // visible error that self-corrects to the "not found" path.
        //
        // Compare against `searchString.length` (not `oldString.length`) because
        // `searchString` may have been adjusted by line-ending normalization
        // above (e.g., `\n` → `\r\n` adds characters). The length-preservation
        // check must verify that curly-quote normalization itself is 1:1, not
        // that it undoes the line-ending change.
        const lengthPreserved =
          normalizedContent.length === content.length &&
          normalizedSearch.length === searchString.length;
        if (lengthPreserved && normalizedContent.includes(normalizedSearch)) {
          usedCurlyQuoteNorm = true;
          // If we also applied line-ending normalization in the combined path,
          // adjust newString now. The standalone CRLF path adjusts newString
          // inline, but the combined path deferred it via `usedLineEndingNorm`.
          if (usedLineEndingNorm) {
            const fileHasCRLF = content.includes("\r\n");
            if (fileHasCRLF) {
              newString = newString.replace(/\n/g, "\r\n");
            } else {
              newString = newString.replace(/\r\n/g, "\n");
            }
          }
          // Find the actual string in the original content using normalized positions.
          // This is safe because normalizeCurlyQuotes maps each character 1:1
          // (curly quotes like U+2018 are single UTF-16 code units, same as
          // their straight-quote replacements), so string indices are preserved.
          const idx = normalizedContent.indexOf(normalizedSearch);
          searchString = originalContent.substring(
            idx,
            idx + normalizedSearch.length
          );
        } else {
          // Show a preview of what was searched for and basic file info to
          // help the LLM self-correct typos, whitespace mismatches, or stale
          // file content assumptions. Including the file's line count helps
          // the model orient — e.g., if it expected a 200-line file but it's
          // actually 50 lines, it knows its context is outdated. Truncate the
          // preview to avoid flooding the output on very long search strings.
          const preview = oldString.length > 200
            ? safeTruncate(oldString, 200) + "…"
            : oldString;
          const fileLineCount = countLines(originalContent);

          // Near-match diagnostic: find the first line of old_string in the file
          // and show context around it. When the model's old_string is close but
          // not exact (e.g., wrong indentation, stale content from a prior edit,
          // or a missing/extra line), the "not found" error alone gives no
          // indication of WHERE the mismatch is or what the file actually contains
          // at that location. The model typically re-reads the entire file and
          // retries blindly — wasting a turn and context tokens.
          //
          // By finding the first line of old_string in the file and showing the
          // surrounding lines, the model can immediately see the actual content
          // and self-correct in a single retry. This is especially valuable for
          // multi-line edits where a single line differs (e.g., a comment changed
          // or an import was added/removed).
          //
          // Only perform this diagnostic when old_string is non-trivial (>= 10
          // chars) and multi-line — for short single-line strings, the "not found"
          // message is sufficient and a near-match search would produce too many
          // false positives. Also skip for very large old_string values (> 2000
          // chars) to avoid O(n*m) scanning on large files.
          let nearMatchHint = "";
          const firstNewline = oldString.indexOf("\n");
          if (
            oldString.length >= 10 &&
            oldString.length <= 2000 &&
            firstNewline > 0
          ) {
            // Extract the first non-empty line from old_string as a search anchor
            const firstLine = oldString.substring(0, firstNewline).trim();
            if (firstLine.length >= 5) {
              // Split on /\r?\n/ to handle both LF and CRLF line endings.
              // `readFileSync(fd, "utf-8")` preserves the file's original
              // line endings, so CRLF files produce lines with trailing \r.
              // The model's `old_string` typically won't have \r (the Read
              // tool's output uses LF), so `line.includes(firstLine)` would
              // fail to find a near-match on CRLF files — the \r in the
              // content line makes `"  foo\r".includes("  foo")` succeed but
              // `"  foo\r".includes("  foo\r\n  bar")` can cause mismatches
              // in the full-string comparison. Stripping \r at split time
              // ensures consistent matching regardless of line ending style.
              const contentLines = originalContent.split(/\r?\n/);
              // Find the first line in the file that contains the anchor text
              const anchorIdx = contentLines.findIndex(
                (line) => line.includes(firstLine)
              );
              if (anchorIdx !== -1) {
                // Show a window around the anchor line — enough context for
                // the model to see what actually exists in the file.
                const oldLineCount = oldString.split("\n").length;
                const windowSize = Math.max(oldLineCount + 2, 5);
                const startLine = Math.max(0, anchorIdx - 1);
                const endLine = Math.min(contentLines.length, anchorIdx + windowSize);
                const contextSnippet = contentLines
                  .slice(startLine, endLine)
                  .map((line, i) => {
                    const lineNum = startLine + i + 1;
                    const truncatedLine = line.length > 200
                      ? safeTruncate(line, 200) + "…"
                      : line;
                    return `${String(lineNum).padStart(4, " ")}│ ${truncatedLine}`;
                  })
                  .join("\n");
                nearMatchHint =
                  `\n\nThe first line of old_string was found at line ${anchorIdx + 1}, ` +
                  `but the full multi-line match failed. The file contains:\n${contextSnippet}` +
                  `\n\nCompare this with your old_string to find the mismatch.`;
              }
            }
          }

          return {
            // Include the file path in the error message. When the model issues
            // multiple Edit calls in parallel (common for multi-file refactors),
            // omitting the path makes it impossible to determine which edit failed.
            // Previously the message said only "old_string not found in file"
            // with no indication of which file — the model had to correlate the
            // error with its tool_use blocks by position, which is unreliable and
            // often led to the model retrying edits on the wrong file.
            content: `Error: old_string not found in ${filePath} (${fileLineCount} lines). Make sure it matches exactly (including whitespace and indentation). Re-read the file to verify its current content.\n\nSearched for:\n${preview}${nearMatchHint}`,
            is_error: true,
          };
        }
      }

      // Track how many replacements were made so the success output can report
      // the exact count for `replace_all` edits. Without this, the model has
      // to manually count diff hunks to verify that all intended occurrences
      // were replaced — error-prone for large files with many matches, and
      // impossible when the diff is truncated. Initialized to 1 for the
      // single-replace path; overwritten in the replace_all branches below.
      let replacementCount = 1;

      if (!replaceAll) {
        // Check uniqueness — when multiple occurrences exist, report the count
        // and line numbers so the LLM can self-correct by adding surrounding
        // context to disambiguate, or by switching to replace_all: true.
        //
        // When curly-quote normalization was used, we must search the
        // *normalized* content for duplicates.  `searchString` was extracted
        // from the first normalized match's exact characters, so a second
        // occurrence with a different curly-quote variant (e.g., U+201C vs
        // U+2018) won't match via `content.indexOf(searchString)` — the
        // uniqueness check would incorrectly pass, and the edit would silently
        // replace only the first variant, violating the "must be unique"
        // contract.  Searching the normalized content catches all
        // semantically-equivalent occurrences regardless of quote style.
        const uniqueCheckContent = usedCurlyQuoteNorm ? normalizeCurlyQuotes(content) : content;
        const uniqueCheckNeedle = usedCurlyQuoteNorm ? normalizeCurlyQuotes(searchString) : searchString;
        const firstIdx = uniqueCheckContent.indexOf(uniqueCheckNeedle);
        const secondIdx = uniqueCheckContent.indexOf(uniqueCheckNeedle, firstIdx + 1);
        if (secondIdx !== -1) {
          // Count total occurrences and collect line numbers using a
          // single-pass approach: track line numbers by counting newlines
          // between successive match positions. The previous implementation
          // called `content.substring(0, idx).split("\n").length` for every
          // occurrence, which is O(n*m) — each call creates a new substring
          // and splits it. This version is O(n) overall since each character
          // is only scanned once for newlines.
          let count = 0;
          const lineNumbers: number[] = [];
          let searchFrom = 0;
          // `currentLine` tracks the 1-based line number at `searchFrom`.
          let currentLine = 1;
          while (true) {
            const idx = uniqueCheckContent.indexOf(uniqueCheckNeedle, searchFrom);
            if (idx === -1) break;
            count++;
            // Count newlines between searchFrom and idx to advance currentLine
            for (let k = searchFrom; k < idx; k++) {
              if (uniqueCheckContent.charCodeAt(k) === 10) currentLine++;
            }
            lineNumbers.push(currentLine);
            searchFrom = idx + 1;
            // Cap the search to avoid excessive work on pathological inputs
            if (count >= 50) break;
          }
          const lineInfo = count <= 50
            ? `Found ${count} occurrences at line${count !== 1 ? "s" : ""}: ${lineNumbers.join(", ")}.`
            : `Found 50+ occurrences (showing first 50 at lines: ${lineNumbers.join(", ")}).`;
          return {
            content: `Error: old_string appears multiple times in the file. ${lineInfo} Use replace_all: true to replace all, or include more surrounding context to make the match unique.`,
            is_error: true,
          };
        }
        // Use a function replacement to prevent interpretation of special
        // replacement patterns like dollar-sign sequences in newString.
        // String.prototype.replace treats certain dollar-prefixed patterns
        // in the replacement string as back-references (e.g. $& inserts the
        // matched substring). Using a function avoids this entirely.
        content = content.replace(searchString, () => newString);
      } else if (usedCurlyQuoteNorm) {
        // When curly-quote normalization was used and replace_all is true,
        // different occurrences may have different curly-quote variants
        // (e.g., one with \u2018 and another with \u2019).  The simple
        // split/join on `searchString` would only replace occurrences
        // matching the first variant's exact characters.  Instead, find
        // ALL occurrences via the normalized content and replace each one
        // with its actual text from the original.
        const normalizedContent = normalizeCurlyQuotes(content);
        const normalizedSearch = normalizeCurlyQuotes(searchString);
        const parts: string[] = [];
        let cursor = 0;
        replacementCount = 0;
        let searchIdx = normalizedContent.indexOf(normalizedSearch, cursor);
        while (searchIdx !== -1) {
          parts.push(content.substring(cursor, searchIdx));
          parts.push(newString);
          replacementCount++;
          cursor = searchIdx + normalizedSearch.length;
          searchIdx = normalizedContent.indexOf(normalizedSearch, cursor);
        }
        parts.push(content.substring(cursor));
        content = parts.join("");
      } else {
        // Use a function replacement to prevent interpretation of special
        // replacement patterns like dollar-sign sequences ($&, $`, $', $1,
        // etc.) in newString — same reason as the single-replace path above.
        // `replaceAll()` (available since Node.js 15, we target 18+) is
        // preferred over the previous `split(searchString).join(newString)`
        // approach: it avoids creating an intermediate array proportional to
        // the number of occurrences, and is semantically clearer.
        //
        // Use the replacement callback to count occurrences. Previously
        // `replacementCount` stayed at its initial value of 1 because the
        // count was only tracked in the curly-quote normalization branch —
        // making it incorrect for the common non-curly-quote `replace_all`
        // path. Now both `replace_all` branches correctly count replacements.
        replacementCount = 0;
        content = content.replaceAll(searchString, () => {
          replacementCount++;
          return newString;
        });
      }

      if (content === originalContent) {
        return {
          content: `Error: The replacement produced no change in the file. The old_string and new_string may be semantically equivalent after normalization.`,
          is_error: true,
        };
      }

      // Guard against replacements that blow up the file size. When
      // `replace_all` is true and `old_string` matches many times, each match
      // is replaced with `new_string` — if `new_string` is much larger than
      // `old_string`, the resulting content can grow far beyond the original
      // file size (e.g., replacing "x" with a 1000-char block across 10,000
      // matches produces ~10 MB of new content from a tiny file). Without this
      // check, the bloated content would be written to disk, potentially filling
      // the filesystem, and the subsequent diff generation (O(n*m) for large
      // inputs) could OOM the process. The check runs after replacement but
      // before the atomic write — no I/O has occurred yet, so we can bail
      // cleanly without affecting the original file.
      const newContentBytes = Buffer.byteLength(content, "utf-8");
      if (newContentBytes > MAX_EDIT_FILE_SIZE_BYTES) {
        const sizeMB = (newContentBytes / (1024 * 1024)).toFixed(1);
        return {
          content: `Error: The replacement would produce a ${sizeMB} MB file, exceeding the ${MAX_EDIT_FILE_SIZE_BYTES / (1024 * 1024)} MB limit. ` +
            `This is likely due to replace_all replacing many short matches with much longer text. ` +
            `Use Bash with sed or awk for large-scale replacements, or reduce the scope of the edit.`,
          is_error: true,
        };
      }

      // Atomic write: write to a temp file in the same directory, then rename
      // over the original.  This prevents data loss if the write fails partway
      // through (e.g., disk full, process killed): the original file remains
      // intact because `renameSync` is atomic on the same filesystem.
      //
      // Uses atomicReplace() which falls back to copy+unlink when the temp file
      // and target are on different filesystems (EXDEV — common with Docker bind
      // mounts, NFS, or symlinks crossing mount points).
      //
      // The temp file uses `openSync("wx")` (exclusive create) to avoid
      // collisions with concurrent edits.
      //
      // Uses `editPath` (the resolved symlink target) for both the temp file
      // directory and the atomicReplace target. This ensures:
      //   1. The temp file is on the same filesystem as the target (same mount
      //      point), so `renameSync` succeeds without triggering the EXDEV fallback.
      //   2. `renameSync(tmp, editPath)` replaces the target file, NOT the symlink
      //      itself — preserving the symlink. Without this, `renameSync(tmp,
      //      symlinkPath)` would destroy the symlink (same fix as write.ts).
      {
        // Truncate the base filename to prevent ENAMETOOLONG on the temp file.
        // Same guard as write.ts: the suffix (.edit.tmp.<pid>.<timestamp>.<counter>)
        // adds ~33 chars plus a leading dot. Files with 200+ char names (common
        // in test fixtures, monorepo packages, or generated code) would push the
        // temp name past NAME_MAX (255 on Linux/macOS) or MAX_PATH (260 on Windows),
        // causing openSync("wx") to fail with ENAMETOOLONG despite the target path
        // being valid. 100 chars retains enough for debugging while leaving room.
        const editBaseName = basename(editPath);
        const safeEditBase = editBaseName.length > 100 ? editBaseName.slice(0, 100) : editBaseName;
        const tmpPath = resolve(
          dirname(editPath),
          `.${safeEditBase}.edit.tmp.${process.pid}.${Date.now()}.${tmpCounter++}`
        );
        try {
          const wfd = openSync(tmpPath, "wx");
          try {
            writeSync(wfd, content, 0, "utf-8");
          } finally {
            closeSync(wfd);
          }
          // Atomically replace the target with the temp file.
          // Uses editPath (the resolved symlink target) so that renameSync
          // replaces the target file, not the symlink itself.
          // Falls back to copy+unlink on cross-filesystem (EXDEV) scenarios.
          atomicReplace(tmpPath, editPath);
          // Read the mtime of the now-replaced file.
          const wstat = statSync(editPath);
          // Record under the original filePath (which the LLM will use in
          // subsequent Read/Edit calls). Also record under editPath if it
          // differs (symlink case), so either path works for the read-before-
          // write guard.
          context.readFileState.set(filePath, { timestamp: wstat.mtimeMs });
          if (editPath !== filePath) {
            context.readFileState.set(editPath, { timestamp: wstat.mtimeMs });
          }
        } catch (writeErr) {
          // Clean up the temp file on failure (best-effort).
          try { unlinkSync(tmpPath); } catch { /* ignore */ }
          throw writeErr;
        }
      }

      // Generate diff — truncate if very large to avoid flooding the context
      // with thousands of changed lines (common with replace_all on large files).
      // Wrap in try/catch because `createTwoFilesPatch` can throw on edge cases
      // (e.g., very large files with pathological diff characteristics, or files
      // containing characters that confuse the diff algorithm). The file has
      // already been successfully written at this point, so a diff failure should
      // degrade to a success message without a diff rather than crashing the
      // entire edit operation and misleading the model into thinking the edit failed.
      const MAX_DIFF_LENGTH = 20000;

      // Build a replacement count suffix for replace_all edits so the model
      // can verify at a glance that the expected number of occurrences were
      // replaced — especially useful when the diff is truncated or skipped
      // (the count is the only signal of how many changes were made).
      // For single replacements (replaceAll === false), the suffix is empty
      // since the count is always 1 and adds no information.
      const countSuffix = replaceAll && replacementCount > 0
        ? ` (${replacementCount} occurrence${replacementCount !== 1 ? "s" : ""} replaced)`
        : "";

      // Build a curly-quote normalization notice when the match was only found
      // via curly-quote normalization (e.g., U+2018/U+2019 → ' or U+201C/U+201D → ").
      // Without this, neither the user nor the model knows that the old_string
      // contained curly quotes that didn't match the file literally — the edit
      // silently succeeds, and the model has no feedback that its input was
      // "fixed up". This matters because:
      //   1. The model may keep submitting curly quotes in future edits, relying
      //      on silent normalization — but if the normalization logic ever changes
      //      or if a new curly quote variant is encountered, edits will break.
      //   2. The user can't audit edits properly if they don't know normalization
      //      was applied — the diff shows straight quotes in the "before" context
      //      but the old_string had curly quotes, which is confusing.
      const normNote = usedCurlyQuoteNorm
        ? "[Note: Matched via curly-quote normalization (\u2018\u2019\u201C\u201D \u2192 straight quotes). Consider using straight quotes in future edits.]\n"
        : "";

      // Skip diff generation entirely when both the original and new content are
      // very large. `createTwoFilesPatch` uses an O(n*m) LCS algorithm that can
      // allocate hundreds of megabytes of intermediate state for large inputs
      // (e.g., two 5 MB strings → ~25 TB of virtual table entries in the worst
      // case, though the `diff` library uses optimizations). Even with good
      // heuristics, the resulting diff will certainly exceed MAX_DIFF_LENGTH and
      // be truncated anyway — so the expensive computation is pure waste.
      // The threshold (500 KB) is chosen to be well above typical edit sizes
      // (most edits are <10 KB) while catching the pathological cases early.
      const DIFF_SKIP_THRESHOLD = 500_000;
      if (originalContent.length > DIFF_SKIP_THRESHOLD && content.length > DIFF_SKIP_THRESHOLD) {
        const linesBefore = countLines(originalContent);
        const linesAfter = countLines(content);
        const sizeDelta = content.length - originalContent.length;
        const sign = sizeDelta >= 0 ? "+" : "";
        return {
          content: `${normNote}Edit applied successfully to ${filePath}${countSuffix} (${linesBefore} → ${linesAfter} lines, ${sign}${sizeDelta} chars). Diff skipped for large file — re-read to verify.`,
        };
      }

      try {
        const diff = createTwoFilesPatch(
          filePath,
          filePath,
          originalContent,
          content,
          "before",
          "after"
        );

        if (diff.length > MAX_DIFF_LENGTH) {
          // Use safeTruncate to avoid splitting surrogate pairs at the cut point.
          const truncated = safeTruncate(diff, MAX_DIFF_LENGTH);
          const totalChangedLines = (diff.match(/\n[+-]/g) || []).length;
          return {
            content: `${normNote}${truncated}\n\n... (diff truncated — ${totalChangedLines} changed lines total${countSuffix}, showing first ${MAX_DIFF_LENGTH} chars)`,
          };
        }

        // For replace_all edits, append the replacement count after the diff
        // so the model can verify the expected number of replacements without
        // manually counting diff hunks. For single replacements, the diff
        // alone is sufficient context.
        if (countSuffix || normNote) {
          return { content: `${normNote}${diff}${countSuffix ? `\n${countSuffix}` : ""}` };
        }
        return { content: diff };
      } catch {
        // Diff generation failed, but the file was written successfully.
        // Return a success message so the model knows the edit was applied.
        const linesBefore = countLines(originalContent);
        const linesAfter = countLines(content);
        return {
          content: `${normNote}Edit applied successfully to ${filePath}${countSuffix} (${linesBefore} → ${linesAfter} lines). Diff generation failed — re-read the file to verify.`,
        };
      }
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      // Provide actionable messages for common filesystem errors.
      // Edit involves both reading (openSync) and writing (writeSync),
      // so it can hit permission errors on either operation.
      //
      // Include the file path in file-specific error messages so the model
      // can identify which file failed when multiple Edit calls run in
      // parallel (the model receives multiple tool_result blocks correlated
      // only by tool_use_id). Re-derive the path from `input.file_path`
      // since the `filePath` const is scoped to the try block. This matches
      // the pattern already applied to read.ts and write.ts (improvement #17).
      if (hasErrnoCode(err)) {
        // Re-derive the path from input for error messages.
        // Use String() to guard against non-string values since we're
        // outside the try block where validation already ran.
        const errPath = typeof input.file_path === "string"
          ? resolve(context.cwd, input.file_path.trim())
          : "(unknown path)";
        // ENOENT during edit can occur when the file is deleted between the
        // initial statSync/read-before-write check and the openSync or the
        // atomic write's statSync (TOCTOU race). It can also occur when a
        // parent directory in the path is deleted mid-operation, or when the
        // temp file's target directory doesn't exist. Without this handler,
        // the error falls through to the generic "Error editing file: ENOENT:
        // no such file or directory" message — which doesn't tell the model
        // that the file was likely deleted externally and should be re-read.
        // write.ts already handles ENOENT (improvement #17); edit.ts was
        // missing the same handler.
        if (err.code === "ENOENT") {
          return {
            content: `Error: File not found: ${errPath}. The file may have been deleted or renamed since it was last read. Re-read the file to verify it still exists, or use the Write tool to recreate it.`,
            is_error: true,
          };
        }
        if (err.code === "EACCES" || err.code === "EPERM") {
          return {
            content: `Error: Permission denied for ${errPath}. The current user does not have read/write access to the file. Use Bash with "ls -la" to check permissions.`,
            is_error: true,
          };
        }
        if (err.code === "ENOSPC") {
          return {
            content: `Error: No space left on device. The disk is full — free up space before editing. Use Bash with "df -h" to check available space.`,
            is_error: true,
          };
        }
        if (err.code === "EROFS") {
          return {
            content: `Error: ${errPath} is on a read-only file system and cannot be edited.`,
            is_error: true,
          };
        }
        if (err.code === "ENAMETOOLONG") {
          return {
            content: `Error: File path is too long for the filesystem. Shorten the directory names or file name, or use a path closer to the root.`,
            is_error: true,
          };
        }
        if (err.code === "ELOOP") {
          return {
            content: `Error: Too many symbolic links encountered resolving ${errPath} (circular symlink chain). Check the symlinks along the path with "ls -la".`,
            is_error: true,
          };
        }
        if (err.code === "EMFILE" || err.code === "ENFILE") {
          return {
            content: `Error: Too many open files. The system file descriptor limit has been reached. Close some files or increase the limit with "ulimit -n".`,
            is_error: true,
          };
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error editing file: ${msg}`, is_error: true };
    }
  },
};
