import { mkdirSync, openSync, writeSync, closeSync, statSync, lstatSync, realpathSync, unlinkSync } from "fs";
import { resolve, dirname, basename } from "path";
import type { Tool, ToolInput, ToolContext, ToolResult } from "../core/types.js";
import { requireFilePath, ToolInputError, hasErrnoCode, countLines } from "./validate.js";
import { atomicReplace } from "./fs-utils.js";
import { printWarning } from "../ui/ui.js";

/**
 * Maximum content size (bytes) that the Write tool will accept. Larger writes
 * could exhaust memory during `Buffer.byteLength`, `split("\n")`, and the
 * atomic write operations. The LLM can use Bash with `cat`, `tee`, or
 * heredoc for legitimately large files.
 */
const MAX_WRITE_CONTENT_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Monotonically increasing counter appended to temp file names to prevent
 * collisions when two Write calls occur within the same millisecond (possible
 * with concurrent tool execution). `Date.now()` alone has only millisecond
 * resolution, and `process.pid` is constant — so two writes to the same
 * directory in the same ms would produce identical temp paths, causing the
 * second `openSync("wx")` to fail with EEXIST.
 */
let tmpCounter = 0;

export const writeTool: Tool = {
  name: "Write",
  description:
    "Write a file to the local filesystem. Creates parent directories if needed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
  isConcurrencySafe: false,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    try {
      const filePathRaw = requireFilePath(input, "file_path");
      // content is required but may be empty (e.g., creating .gitkeep or clearing a file),
      // so we can't use requireString which rejects empty strings.
      if (typeof input.content !== "string") {
        throw new ToolInputError(`Missing or invalid required parameter "content": expected a string`);
      }
      const content: string = input.content;
      const filePath = resolve(context.cwd, filePathRaw);

      // Guard against extremely large content that would exhaust memory during
      // the write pipeline (Buffer.byteLength, split("\n"), writeSync). The
      // LLM could hallucinate huge generated files or a restored session could
      // contain corrupted data. 10 MB is generous for any file the LLM should
      // realistically generate in a single Write call.
      const contentBytes = Buffer.byteLength(content, "utf-8");
      if (contentBytes > MAX_WRITE_CONTENT_BYTES) {
        const sizeMB = (contentBytes / (1024 * 1024)).toFixed(1);
        return {
          content: `Error: Content is too large to write (${sizeMB} MB). Maximum supported size is ${MAX_WRITE_CONTENT_BYTES / (1024 * 1024)} MB. Use Bash with cat/tee/heredoc for large files, or split the content across multiple files.`,
          is_error: true,
        };
      }

      // Determine whether the file already exists using a single `statSync`
      // instead of `existsSync` + separate stat. This eliminates a TOCTOU race
      // where the file could be created or deleted between the existence check
      // and the subsequent operations (same pattern applied to read.ts and
      // edit.ts in improvements #25 and #31). If the file is created by another
      // process between `existsSync(false)` and the atomic write, we'd overwrite
      // it without the read-before-write guard ever firing, potentially losing
      // the external process's content.
      let isNewFile: boolean;
      let existingMtimeMs: number | undefined;
      // The effective path to write to. For symlinks, this is resolved to the
      // real target path so the atomic replace operates on the target file
      // rather than the symlink itself. Without this, `renameSync(tmp, symlinkPath)`
      // replaces the symlink with a regular file (destroying the symlink),
      // which is almost never the user's intent.
      let writePath = filePath;
      try {
        const stat = statSync(filePath);
        isNewFile = false;
        existingMtimeMs = stat.mtimeMs;

        // Guard against writing to a directory path. statSync succeeds on
        // directories, but atomicReplace (renameSync) fails with EISDIR when
        // the target is a directory — producing a confusing platform-dependent
        // error. Catch this early with a clear message, matching read.ts's and
        // edit.ts's explicit directory checks.
        if (stat.isDirectory()) {
          return {
            content: `Error: ${filePath} is a directory, not a file. Use a file path instead, or choose a different filename.`,
            is_error: true,
          };
        }

        // Guard against writing to device files (character/block devices,
        // FIFOs, sockets). These are not regular files — writing to them has
        // side effects beyond "save content to disk":
        //   - Character devices (e.g., /dev/sda): direct disk writes, data loss
        //   - Block devices: raw partition writes bypassing the filesystem
        //   - FIFOs (named pipes): blocks until a reader connects, hangs the tool
        //   - Sockets: Unix domain sockets, not meaningful for file writes
        //
        // `statSync` follows symlinks, so `stat.isFile()` returns true for both
        // regular files and symlinks-to-regular-files. We only need `!stat.isFile()`
        // here — matching the same guard already applied in read.ts (improvement #25)
        // where these were already detected and rejected.
        //
        // Note: the read-before-write guard (below) would also block most of
        // these since the Read tool rejects non-regular files, but this check
        // covers the case where a special file was never read (new file flag
        // might not be set if statSync succeeded) or was in readFileState from
        // a previous session.
        if (!stat.isFile()) {
          const kind = stat.isCharacterDevice() ? "character device"
            : stat.isBlockDevice() ? "block device"
            : stat.isFIFO() ? "FIFO/pipe"
            : stat.isSocket() ? "socket"
            : "special file";
          return {
            content: `Error: ${filePath} is a ${kind}, not a regular file. The Write tool only works on regular files. Use Bash to interact with special files.`,
            is_error: true,
          };
        }

        // If filePath is a symlink, resolve it to the real target path.
        // lstatSync doesn't follow symlinks, so if it reports a symlink but
        // statSync succeeded (above), the target exists and is valid.
        // We use the resolved path for: (1) readFileState lookup, (2) the
        // atomic replace target, ensuring the symlink is preserved.
        try {
          const lstat = lstatSync(filePath);
          if (lstat.isSymbolicLink()) {
            writePath = realpathSync(filePath);
          }
        } catch (lstatErr: unknown) {
          // If lstatSync fails for a non-ENOENT reason (e.g., EACCES, ELOOP),
          // log a warning so the error is visible for debugging. Previously all
          // errors were silently swallowed, making it impossible to diagnose
          // why symlink resolution failed (the write would proceed to the
          // original path, potentially replacing the symlink with a regular
          // file instead of writing through it to the target).
          if (hasErrnoCode(lstatErr) && lstatErr.code !== "ENOENT") {
            const code = lstatErr.code;
            printWarning(`Could not check symlink status for ${filePath} (${code}) — proceeding with original path.`);
          }
          // Fall through with the original filePath — statSync succeeded so
          // the path is valid, just can't determine if it's a symlink.
        }
      } catch (statErr: unknown) {
        if (hasErrnoCode(statErr) && statErr.code === "ENOENT") {
          isNewFile = true;
        } else {
          // Re-throw non-ENOENT errors (EACCES, ELOOP, etc.) so the outer
          // catch handler can provide an actionable error message.
          throw statErr;
        }
      }

      // Read-before-write guard: if file already exists, must have been read first.
      // Use `get()` directly instead of `has()` + later `get()` to avoid a
      // TOCTOU race with LRU eviction (same fix applied to edit.ts).
      // Check both the original path and the resolved symlink target — the Read
      // tool may have recorded the state under either path depending on how the
      // user specified it. Skip the second lookup when writePath === filePath
      // (non-symlink case, the majority) to avoid a redundant LRU promotion —
      // `get()` re-inserts the entry to update recency, so calling it twice on
      // the same key wastes a delete+set cycle and may alter eviction order
      // relative to concurrent reads on other paths.
      if (!isNewFile) {
        const savedState = context.readFileState.get(filePath) ?? (writePath !== filePath ? context.readFileState.get(writePath) : undefined);
        if (!savedState) {
          return {
            content: `Error: You must read the file before overwriting it. Use the Read tool first on: ${filePath}`,
            is_error: true,
          };
        }

        // Compare the mtime from our stat above against the saved state.
        // Use 1000ms tolerance because some filesystems have coarse timestamp
        // resolution (FAT32: 2s, ext3/HFS+: 1s), so a tighter threshold
        // would cause spurious false positives on those systems.
        if (existingMtimeMs !== undefined && Math.abs(existingMtimeMs - savedState.timestamp) > 1000) {
          return {
            content: `Error: File has been modified since last read (mtime mismatch). Re-read the file before writing: ${filePath}`,
            is_error: true,
          };
        }
      }

      // Ensure parent directory exists. Use writePath's directory so when
      // writing through a symlink, the temp file is in the target's directory
      // (same filesystem for atomic rename).
      // Use recursive:true unconditionally — it's a no-op if the dir exists,
      // and avoids a TOCTOU race where existsSync(dir) returns false but
      // another process creates the dir before mkdirSync runs.
      const dir = dirname(writePath);
      mkdirSync(dir, { recursive: true });

      // Atomic write: write to a temp file in the same directory, then rename
      // over the original.  This prevents data loss if the write fails partway
      // through (e.g., disk full, process killed): the original file remains
      // intact because `renameSync` is atomic on the same filesystem.
      //
      // Uses atomicReplace() which falls back to copy+unlink when the temp file
      // and target are on different filesystems (EXDEV — common with Docker bind
      // mounts, NFS, or symlinks crossing mount points).
      //
      // For new files, we still use the atomic pattern so that a partial write
      // (ENOSPC mid-write) doesn't leave a half-written file on disk.
      //
      // The temp file uses `openSync("wx")` (exclusive create) to avoid
      // collisions with concurrent writes (matching the pattern in edit.ts).
      let newMtimeMs: number;
      {
        // Truncate the base filename to prevent ENAMETOOLONG on the temp file.
        // The suffix (.write.tmp.<pid>.<timestamp>.<counter>) adds ~35 chars,
        // plus the leading dot. On Windows, MAX_PATH is 260 chars by default;
        // even on Linux/macOS (NAME_MAX = 255), a file named with 200+ chars
        // (common in generated code, test fixtures, or monorepo packages like
        // "@scope__package-name__sub-module.integration.test.ts") would push
        // the temp name past 255, causing openSync("wx") to fail with
        // ENAMETOOLONG — a confusing error since the TARGET path is fine.
        // The temp file is immediately renamed/deleted, so the truncated name
        // has no user-visible effect. 100 chars retains enough of the original
        // name for debugging (e.g., `ls /tmp`) while leaving ample room for
        // the suffix in any filesystem's NAME_MAX.
        const baseName = basename(writePath);
        const safeBase = baseName.length > 100 ? baseName.slice(0, 100) : baseName;
        const tmpPath = resolve(
          dir,
          `.${safeBase}.write.tmp.${process.pid}.${Date.now()}.${tmpCounter++}`
        );
        try {
          const wfd = openSync(tmpPath, "wx");
          try {
            writeSync(wfd, content, 0, "utf-8");
          } finally {
            closeSync(wfd);
          }
          // Atomically replace the target with the temp file.
          // Uses writePath (the resolved symlink target) so that renameSync
          // replaces the target file, not the symlink itself. Without this,
          // renameSync(tmp, symlinkPath) would destroy the symlink.
          // Falls back to copy+unlink on cross-filesystem (EXDEV) scenarios.
          atomicReplace(tmpPath, writePath);
          // Read the mtime of the written file.
          const wstat = statSync(writePath);
          newMtimeMs = wstat.mtimeMs;
        } catch (writeErr) {
          // Clean up the temp file on failure (best-effort).
          try { unlinkSync(tmpPath); } catch { /* ignore */ }
          throw writeErr;
        }
      }

      // Update readFileState with new mtime. Record under the original
      // filePath (which the LLM will use in subsequent Read/Edit calls).
      // Also record under writePath if it differs (symlink case), so that
      // either path can be used for the read-before-write guard.
      context.readFileState.set(filePath, { timestamp: newMtimeMs });
      if (writePath !== filePath) {
        context.readFileState.set(writePath, { timestamp: newMtimeMs });
      }

      // Include size and line count in the result so the user (and the LLM)
      // can verify at a glance that the right content was written — especially
      // useful when writing large generated files where a truncation or
      // encoding issue could silently lose content.
      const lineCount = countLines(content);
      // Reuse the byte length computed earlier (line 61) instead of calling
      // Buffer.byteLength a second time — the content hasn't changed since
      // then, and the call is O(n) in the string length.
      const sizeStr = contentBytes < 1024
        ? `${contentBytes} bytes`
        : `${(contentBytes / 1024).toFixed(1)} KB`;
      const action = isNewFile ? "created" : "written";
      const lineWord = lineCount === 1 ? "line" : "lines";

      return {
        content: `File ${action} successfully at: ${filePath} (${lineCount} ${lineWord}, ${sizeStr})`,
      };
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      // Provide actionable messages for common filesystem errors instead of
      // raw errno strings ("ENOSPC: no space left on device") that don't
      // tell the LLM or user what to do about it.
      if (hasErrnoCode(err)) {
        // Access the file path from the raw input for error messages.
        // The `filePath` const is scoped to the try block and inaccessible
        // here. Use String() to guard against non-string values since we're
        // bypassing the validation that already ran (or threw) inside try.
        const errPath = typeof input.file_path === "string" ? resolve(context.cwd, input.file_path.trim()) : "(unknown path)";
        if (err.code === "ENOENT") {
          // ENOENT during write typically means the parent directory doesn't
          // exist (mkdirSync failed or was raced) or a path component was
          // deleted mid-operation. Report this clearly.
          return {
            content: `Error: Path not found — a parent directory may not exist or was deleted during the operation. Re-run the Write tool to retry.`,
            is_error: true,
          };
        }
        if (err.code === "ENOSPC") {
          return {
            content: `Error: No space left on device. The disk is full — free up space before writing. Use Bash with "df -h" to check available space.`,
            is_error: true,
          };
        }
        if (err.code === "EACCES" || err.code === "EPERM") {
          return {
            content: `Error: Permission denied writing to ${errPath}. The current user does not have write access to the target path or its parent directory. Use Bash with "ls -la" to check permissions.`,
            is_error: true,
          };
        }
        if (err.code === "EROFS") {
          return {
            content: `Error: Read-only file system — cannot write to ${errPath}. The target path is on a read-only filesystem.`,
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
      return { content: `Error writing file: ${msg}`, is_error: true };
    }
  },
};
