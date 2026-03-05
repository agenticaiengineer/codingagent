import { renameSync, unlinkSync, copyFileSync } from "fs";
import { dirname, basename, join } from "path";
import { hasErrnoCode } from "./validate.js";

/**
 * Monotonically increasing counter for cross-filesystem temp file names,
 * preventing collisions when multiple EXDEV fallbacks occur in the same
 * millisecond (unlikely but possible with concurrent edits).
 */
let xdevTmpCounter = 0;

/**
 * Atomically replace `targetPath` with `tmpPath` using rename, falling back
 * to copy-via-temp+rename when the files are on different filesystems (EXDEV).
 *
 * `renameSync` is atomic only on the same filesystem — it fails with EXDEV
 * when the source and target are on different mount points (common with Docker
 * bind mounts, NFS, or symlinks crossing filesystem boundaries).
 *
 * The EXDEV fallback copies the source to a temp file *in the target's
 * directory* (same filesystem as the target), then renames that temp file
 * over the target. This two-step approach avoids the data loss risk of
 * `copyFileSync(src, target)` directly: `copyFileSync` overwrites the target
 * in-place, so if the process is killed mid-copy (SIGKILL, OOM, power loss),
 * the target is left in a partially-written state with no recovery path.
 * By copying to a temp file first, the original target is untouched until the
 * final (atomic) `renameSync`.
 *
 * Shared by both `write.ts` and `edit.ts` — previously duplicated across both
 * files, risking silent divergence if only one copy was updated.
 */
export function atomicReplace(tmpPath: string, targetPath: string): void {
  try {
    renameSync(tmpPath, targetPath);
  } catch (err: unknown) {
    if (hasErrnoCode(err) && err.code === "EXDEV") {
      // Cross-filesystem: copy to a temp file in the target's directory
      // (same filesystem as the target), then rename over the target.
      // This ensures the original target is never in a partially-written
      // state — the rename is atomic because both paths are on the same FS.
      const targetDir = dirname(targetPath);
      // Use path.join() instead of string concatenation with "/" to produce
      // platform-appropriate path separators. Previously the template literal
      // `${targetDir}/${...}` hardcoded a forward slash, producing mixed-
      // separator paths on Windows (e.g., `C:\dir/.foo.xdev.tmp.1234.1234.0`).
      // While Node.js on Windows can handle mixed separators for file operations,
      // mixed-separator paths cause issues with string-based path comparisons
      // (e.g., in readFileState lookups where `C:\dir/.foo` !== `C:\dir\.foo`),
      // and confuse diagnostic messages shown to the user. path.join() ensures
      // consistent separators matching the platform convention.
      const tmpInTarget = join(targetDir, `.${basename(targetPath)}.xdev.tmp.${process.pid}.${Date.now()}.${xdevTmpCounter++}`);
      try {
        copyFileSync(tmpPath, tmpInTarget);
        renameSync(tmpInTarget, targetPath);
      } catch (copyErr: unknown) {
        // Clean up the intermediate temp file on failure (best-effort).
        try { unlinkSync(tmpInTarget); } catch { /* ignore */ }
        throw copyErr;
      }
      // Clean up the original source temp file (best-effort).
      try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    } else {
      throw err;
    }
  }
}
