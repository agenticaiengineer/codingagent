import { readFileSync, statSync, fstatSync, openSync, readSync, closeSync } from "fs";
import { resolve, extname } from "path";
import type { Tool, ToolInput, ToolContext, ToolResult } from "../core/types.js";
import { requireFilePath, optionalInteger, ToolInputError, hasErrnoCode, safeTruncate } from "./validate.js";

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
]);

/**
 * SVG files are intentionally excluded from IMAGE_EXTENSIONS.
 * SVGs are XML-based text — base64-encoding them discards all the useful
 * textual content (element names, classes, IDs, inline styles, structure)
 * that the LLM can analyze and edit. The null-byte binary detection
 * heuristic correctly identifies SVGs as text and returns readable content
 * with line numbers, just like any other source file.
 */

/**
 * Maximum file size (in bytes) we allow reading in full.
 * Files larger than this are rejected with a helpful error.
 * 50 MB is generous for source code while preventing OOM on multi-GB files.
 */
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Maximum image file size (in bytes) we allow reading via the Read tool.
 * Image data is base64-encoded before being returned, expanding it by ~33%.
 * A 10 MB image becomes ~13.3 MB of base64 text dumped into the conversation
 * context, which can blow the token limit or trigger immediate auto-compaction.
 * 10 MB is generous for screenshots, diagrams, and UI mockups while preventing
 * context flooding from high-resolution photos or uncompressed bitmaps.
 */
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Threshold (in bytes) above which a full-file read prepends a warning
 * suggesting the use of offset/limit. Reading a 100 KB+ file dumps
 * ~25K+ tokens into the context, which can trigger auto-compaction and
 * push out earlier important context.
 */
const LARGE_FILE_WARNING_BYTES = 100 * 1024; // 100 KB

export const readTool: Tool = {
  name: "Read",
  description:
    "Read a file from the local filesystem. Returns file contents with line numbers.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to read",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-based)",
      },
      limit: {
        type: "number",
        description: "Number of lines to read",
      },
    },
    required: ["file_path"],
  },
  isConcurrencySafe: true,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    try {
      const filePathRaw = requireFilePath(input, "file_path");
      const offsetRaw = optionalInteger(input, "offset");
      const limit = optionalInteger(input, "limit");

      // Validate offset/limit ranges to prevent silent empty output that
      // would confuse the LLM (e.g., offset=0 or limit=-5 returns no lines
      // with no explanation).
      if (offsetRaw !== undefined && offsetRaw < 1) {
        return {
          content: `Error: offset must be >= 1 (1-based line number), got ${offsetRaw}`,
          is_error: true,
        };
      }
      if (limit !== undefined && limit <= 0) {
        return {
          content: `Error: limit must be a positive number, got ${limit}`,
          is_error: true,
        };
      }
      const offset = offsetRaw ?? 1;

      const filePath = resolve(context.cwd, filePathRaw);

      // Use a single statSync in try/catch instead of existsSync + statSync.
      // The previous pattern had a TOCTOU race: the file could be deleted
      // between existsSync (returning true) and statSync (throwing ENOENT),
      // causing an unhandled error. This also eliminates a redundant syscall.
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(filePath);
      } catch (statErr: unknown) {
        if (hasErrnoCode(statErr) && statErr.code === "ENOENT") {
          return { content: `Error: File not found: ${filePath}`, is_error: true };
        }
        throw statErr; // re-throw unexpected errors (EACCES, etc.) for outer catch
      }

      if (stat.isDirectory()) {
        return {
          content: `Error: ${filePath} is a directory, not a file. Use Bash with ls to list directory contents.`,
          is_error: true,
        };
      }

      // Reject device files (character/block devices, FIFOs, sockets) that
      // could hang indefinitely (e.g., /dev/random, /dev/zero) or produce
      // infinite output. stat.size for these is typically 0, so the size
      // guard below doesn't protect against them. Named pipes (FIFOs) would
      // block on open until a writer connects.
      //
      // `statSync` follows symlinks, so `stat.isFile()` returns true for both
      // regular files and symlinks-to-regular-files. We only need `!stat.isFile()`
      // here — `stat.isSymbolicLink()` is always false after `statSync` (it only
      // returns true for `lstatSync`), so checking it was dead code.
      if (!stat.isFile()) {
        const kind = stat.isCharacterDevice() ? "character device"
          : stat.isBlockDevice() ? "block device"
          : stat.isFIFO() ? "FIFO/pipe"
          : stat.isSocket() ? "socket"
          : "special file";
        return {
          content: `Error: ${filePath} is a ${kind}, not a regular file. Use Bash to interact with it.`,
          is_error: true,
        };
      }

      // Guard against reading extremely large files that would cause OOM
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        return {
          content: `Error: File is too large (${sizeMB} MB). Maximum supported size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB. Use Bash with head, tail, or less to read portions of the file.`,
          is_error: true,
        };
      }

      const ext = extname(filePath).toLowerCase();

      // Handle image files
      if (IMAGE_EXTENSIONS.has(ext)) {
        // Reject offset/limit for image files — these parameters operate on
        // text lines and have no meaningful interpretation for binary image
        // data. Silently ignoring them would confuse the model: it might pass
        // `offset: 100, limit: 50` expecting to read "lines 100–150" of a
        // PNG, get the full base64-encoded image with no indication that its
        // parameters were discarded, and waste a turn thinking it received a
        // partial read. A clear error lets the model adjust its approach
        // (e.g., use Bash to inspect image metadata, or omit offset/limit).
        if (offsetRaw !== undefined || limit !== undefined) {
          return {
            content: `Error: offset and limit parameters are not supported for image files (${ext}). Image files are always read in full and returned as base64. Omit these parameters, or use Bash to inspect the image (e.g., "file ${filePath}" or "identify ${filePath}").`,
            is_error: true,
          };
        }

        // Cap image file size separately from text files. Image data is
        // base64-encoded (~33% expansion), so a large image floods the
        // conversation context with far more tokens than its byte size
        // suggests. Without this check, a 49 MB PNG would pass the 50 MB
        // text file limit and return ~65 MB of base64 into the context.
        if (stat.size > MAX_IMAGE_SIZE_BYTES) {
          const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
          const limitMB = MAX_IMAGE_SIZE_BYTES / (1024 * 1024);
          return {
            content: `Error: Image file is too large (${sizeMB} MB). Maximum supported image size is ${limitMB} MB. ` +
              `Large images flood the conversation context due to base64 encoding (~33% expansion). ` +
              `Use Bash to resize the image (e.g., "convert input.png -resize 50% output.png") or inspect its metadata.`,
            is_error: true,
          };
        }
        // Use fd-based reading for images, matching the text file approach
        // below.  Previously `readFileSync(filePath)` + `stat.mtimeMs` had
        // a TOCTOU race: the file could be modified between the initial
        // `statSync` (line 99) and the `readFileSync` here, causing a stale
        // mtime to be stored in `readFileState`.  The write/edit tools
        // would then compare against a stale timestamp and fail to detect
        // that the file was externally modified, allowing the model to
        // overwrite the new content.
        let imgFd = -1;
        try {
          imgFd = openSync(filePath, "r");
          const data = readFileSync(imgFd);
          const imgStat = fstatSync(imgFd);
          try {
            closeSync(imgFd);
          } finally {
            imgFd = -1;
          }

          // Re-check size from the fd in case the file grew since statSync
          if (imgStat.size > MAX_IMAGE_SIZE_BYTES) {
            const sizeMB = (imgStat.size / (1024 * 1024)).toFixed(1);
            const limitMB = MAX_IMAGE_SIZE_BYTES / (1024 * 1024);
            return {
              content: `Error: Image file is too large (${sizeMB} MB, grew since initial check). Maximum supported image size is ${limitMB} MB.`,
              is_error: true,
            };
          }

          const base64 = data.toString("base64");
          context.readFileState.set(filePath, { timestamp: imgStat.mtimeMs });
          return {
            content: `[Image file: ${filePath} (${data.length} bytes, base64 encoded)]\n${base64}`,
          };
        } finally {
          if (imgFd !== -1) {
            try { closeSync(imgFd); } catch { /* already closed */ }
          }
        }
      }

      // Use a single file descriptor for the binary check, content read,
      // and mtime query. This eliminates a TOCTOU race where the file could
      // change between the initial statSync (used for size/directory checks)
      // and the readFileSync, causing the stored mtime to not match the
      // content that was actually read. (Same pattern used in edit.ts.)
      //
      // Detect binary files by checking for null bytes in the first 8 KB.
      // True text files (UTF-8/ASCII/Latin) never contain null bytes.
      // This is the same heuristic used by Git and many other tools.
      //
      // We read only the first 8 KB for the binary check rather than the
      // entire file. For large binary files (e.g., 50 MB .wasm), this avoids
      // allocating the full buffer only to discard it when the binary check
      // fails. The full file is only read if it passes the binary check.
      const BINARY_CHECK_SIZE = 8192;
      let content: string;
      let fileMtimeMs: number;
      let fileSize: number;

      if (stat.size > 0) {
        let fd = -1;
        try {
          fd = openSync(filePath, "r");

          // Binary check — sample first 8 KB
          const sampleBuf = Buffer.alloc(Math.min(stat.size, BINARY_CHECK_SIZE));
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
            // closeSync(fd) again. Double-close is dangerous: on some OSes,
            // the fd number may already be reused by a concurrent open(),
            // so closing it again would silently close an UNRELATED file
            // descriptor. Using try/finally ensures fd = -1 runs regardless.
            // (Same fix applied to edit.ts for the identical pattern.)
            try {
              closeSync(fd);
            } finally {
              fd = -1;
            }
            const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
            const inspectTools = process.platform === "win32"
              ? "certutil, type, or file-type-specific tools"
              : "xxd, strings, or file-type-specific tools";
            return {
              content: `Error: "${filePath}" appears to be a binary file (${sizeMB} MB${ext ? `, extension: ${ext}` : ", no extension"}). Use Bash with ${inspectTools} to inspect it.`,
              is_error: true,
            };
          }

          // Read content and stat from the same fd — guaranteed consistent
          content = readFileSync(fd, "utf-8");
          const fdStat = fstatSync(fd);
          fileMtimeMs = fdStat.mtimeMs;
          fileSize = fdStat.size;

          // Re-check file size against the limit. The initial statSync
          // (line 88) guards against obviously-too-large files, but the file
          // can grow between that check and this fd-based read (TOCTOU).
          // If the file grew past MAX_FILE_SIZE_BYTES while we held the fd,
          // the content is already in memory, but we reject it before adding
          // it to the conversation — dumping 50+ MB of text into the context
          // would blow the token limit and trigger immediate compaction.
          if (fileSize > MAX_FILE_SIZE_BYTES) {
            try {
              closeSync(fd);
            } finally {
              fd = -1;
            }
            const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
            return {
              content: `Error: File is too large (${sizeMB} MB, grew since initial check). Maximum supported size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB. Use Bash with head, tail, or less to read portions of the file.`,
              is_error: true,
            };
          }

          try {
            closeSync(fd);
          } finally {
            fd = -1;
          }
        } finally {
          if (fd !== -1) {
            try { closeSync(fd); } catch { /* already closed */ }
          }
        }
      } else {
        // Empty file — no binary check needed, but still open an fd to get a
        // consistent mtime via fstatSync. Previously this used `stat.mtimeMs`
        // from the initial `statSync` (line 99), creating a TOCTOU race: the
        // file could be modified (gaining content) between `statSync` and the
        // `readFileState.set` call below, causing a stale mtime to be stored.
        // A subsequent Write/Edit would compare against the stale timestamp and
        // fail to detect the external modification, allowing the model to
        // overwrite the new content. The non-empty path already uses fd-based
        // mtime (line ~253) for exactly this reason.
        content = "";
        let emptyFd = -1;
        try {
          emptyFd = openSync(filePath, "r");
          const emptyFstat = fstatSync(emptyFd);
          fileMtimeMs = emptyFstat.mtimeMs;
          fileSize = emptyFstat.size;
          // If the file grew between statSync and openSync, it's no longer empty.
          // Don't proceed with empty content — fall through to let the model
          // re-read. This is extremely unlikely but prevents silent data loss.
          if (fileSize > 0) {
            try {
              closeSync(emptyFd);
            } finally {
              emptyFd = -1;
            }
            return {
              content: `Error: File was empty during initial check but has content now (${fileSize} bytes). Please re-read the file.`,
              is_error: true,
            };
          }
        } finally {
          if (emptyFd !== -1) {
            try { closeSync(emptyFd); } catch { /* already closed */ }
          }
        }

        // Return a clear "empty file" message immediately. Previously, the
        // empty string fell through to the line-splitting logic below where
        // `"".split(/\r?\n/)` produces `[""]` (an array with one empty string),
        // causing the output to show `"1\t"` — as if the file had one line of
        // content. This is confusing: the model (and user) sees what looks like
        // a single empty line, not an empty file, and may try to edit "line 1"
        // or assume the file has content. A clear "(empty file)" message lets
        // the model know to use Write (not Edit) and avoids wasted turns.
        context.readFileState.set(filePath, { timestamp: fileMtimeMs });
        // Include the file path in the empty file message. When reading
        // multiple files in parallel, the model receives tool_result blocks
        // correlated only by tool_use_id — the content itself must contain
        // the file path for the model to know WHICH file is empty without
        // cross-referencing IDs. This matches the error message pattern in
        // edit.ts which includes file paths for the same reason.
        return { content: `${filePath}: (empty file — 0 lines)` };
      }

      // Split on both Unix (\n) and Windows (\r\n) line endings. Previously
      // only \n was used, so files with \r\n endings would show a trailing \r
      // on every line in the numbered output (visible as whitespace artifacts
      // in the model's context). More importantly, if the model copies a line
      // from the Read output into an Edit tool call's old_string, the trailing
      // \r would be included — but the model often strips it, causing an exact
      // match failure. Splitting on /\r?\n/ strips \r at split time, producing
      // clean lines regardless of the file's line ending style.
      const allLines = content.split(/\r?\n/);
      const totalLines = allLines.length;
      let lines = allLines;
      let isPartialRead = false;

      if (offset > 1 || limit !== undefined) {
        // If offset is past the end of the file, return a clear message
        // instead of empty content that confuses the LLM.
        if (offset > totalLines) {
          // For empty files (0 lines), don't suggest "offset <= 0" — that
          // contradicts the offset >= 1 requirement. Instead, tell the LLM
          // the file is empty so it can adjust its approach (e.g., use Write
          // instead of trying to read specific lines from an empty file).
          const hint = totalLines === 0
            ? "The file is empty (0 lines)."
            : `Use offset <= ${totalLines}.`;
          return {
            content: `Error: offset ${offset} is beyond the end of the file (${totalLines} total lines). ${hint}`,
            is_error: true,
          };
        }
        const startIdx = Math.max(0, offset - 1);
        const endIdx = limit !== undefined ? startIdx + limit : totalLines;
        lines = allLines.slice(startIdx, endIdx);
        isPartialRead = startIdx > 0 || endIdx < totalLines;
      }

      // Format with line numbers (cat -n style).
      // Track how many lines were truncated so we can inform the LLM —
      // previously truncation was silent ("..."), and the model had no
      // idea that content was lost, potentially causing incorrect edits
      // on lines whose full content it never saw.
      const maxLineNum = offset + lines.length - 1;
      const numWidth = String(maxLineNum).length;
      let truncatedLineCount = 0;
      const numbered = lines
        .map((line, i) => {
          const lineNum = String(offset + i).padStart(numWidth, " ");
          let truncated = line;
          if (line.length > 2000) {
            truncatedLineCount++;
            // Use safeTruncate to avoid splitting a surrogate pair at the
            // 2000-char boundary (e.g., emoji or CJK characters).
            truncated = safeTruncate(line, 2000) + `... [truncated from ${line.length.toLocaleString()} chars]`;
          }
          return `${lineNum}\t${truncated}`;
        })
        .join("\n");

      // Update readFileState — uses mtime from the same fd that produced
      // the content, so the timestamp always matches what was actually read.
      context.readFileState.set(filePath, { timestamp: fileMtimeMs });

      // Build a truncation notice if any lines were cut short.
      // This tells the LLM exactly how much content it's missing so it
      // can decide whether to use Bash (e.g., `cut -c1-5000 file`) to
      // see the full line(s) before attempting an edit.
      const truncNotice = truncatedLineCount > 0
        ? `[Note: ${truncatedLineCount} line${truncatedLineCount > 1 ? "s" : ""} truncated at 2000 chars. Use Bash to see full line content if needed for editing.]\n`
        : "";

      // When showing a partial range, prepend a header so the caller
      // (especially the LLM) knows what portion of the file is displayed
      // and whether more content exists beyond the returned range.
      if (isPartialRead) {
        const startLine = offset;
        const endLine = startLine + lines.length - 1;
        const header = `[Showing lines ${startLine}–${endLine} of ${totalLines} total]`;
        return { content: `${header}\n${truncNotice}${numbered}` };
      }

      // Warn when reading a large file in full — the content consumes
      // significant context tokens and may trigger auto-compaction.
      // The warning is prepended to the output (not an error) so the
      // LLM gets the file content it asked for but learns to use
      // offset/limit for future reads of this file.
      if (fileSize > LARGE_FILE_WARNING_BYTES) {
        const sizeKB = (fileSize / 1024).toFixed(0);
        const warning = `[Warning: Large file (${sizeKB} KB, ${totalLines} lines). Consider using offset/limit to read specific sections to conserve context.]`;
        return { content: `${warning}\n${truncNotice}${numbered}` };
      }

      return { content: `${truncNotice}${numbered}` };
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      // Provide actionable guidance for common filesystem errors instead of
      // a bare "EACCES: permission denied" or "EPERM: operation not permitted"
      // which doesn't tell the LLM how to proceed.
      //
      // Access the file path from the raw input since the `filePath` const is
      // scoped to the try block. Use the same pattern as write.ts (improvement
      // #31) and task.ts (line ~202) for accessing try-block variables from
      // the catch clause.
      if (hasErrnoCode(err)) {
        const errPath = typeof input.file_path === "string" ? resolve(context.cwd, input.file_path.trim()) : "(unknown path)";
        // ENOENT in the catch block means the file was deleted between the
        // initial statSync (which succeeded) and a subsequent filesystem
        // operation — a TOCTOU race. The inline ENOENT handler at the top of
        // the try block only covers the initial stat; if the file disappears
        // between stat and openSync, the raw "ENOENT: no such file or
        // directory" error falls through here with no actionable context.
        // Providing a clear message lets the model know the file was deleted
        // externally and shouldn't be retried blindly. This matches the ENOENT
        // handlers already present in write.ts and edit.ts.
        if (err.code === "ENOENT") {
          return {
            content: `Error: File not found: ${errPath}. The file may have been deleted or renamed after the initial check. Verify the path with Glob or Bash.`,
            is_error: true,
          };
        }
        if (err.code === "EACCES" || err.code === "EPERM") {
          return {
            content: `Error: Permission denied reading ${errPath}. The current user does not have read access. Use Bash with "ls -la" to check permissions, or try "sudo cat" if elevated access is needed.`,
            is_error: true,
          };
        }
        if (err.code === "ELOOP") {
          return {
            content: `Error: Too many symbolic links encountered resolving ${errPath} (circular symlink chain). Check the symlinks along the path with "ls -la".`,
            is_error: true,
          };
        }
        if (err.code === "ENAMETOOLONG") {
          return {
            content: `Error: File path is too long for the filesystem. Check for typos or use a shorter path.`,
            is_error: true,
          };
        }
        if (err.code === "EMFILE" || err.code === "ENFILE") {
          return {
            content: `Error: Too many open files. The system file descriptor limit has been reached. This can happen with many concurrent Read calls. Try again in a moment.`,
            is_error: true,
          };
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error reading file: ${msg}`, is_error: true };
    }
  },
};
