/**
 * session.ts — Session persistence for CodingAgent
 *
 * Saves and loads conversation state to disk, enabling:
 * - Resume previous conversations after restart
 * - Browse and switch between past sessions
 * - Auto-save during the session
 *
 * Sessions are stored as JSON files in ~/.codingagent/sessions/
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, renameSync, statSync, openSync, readSync, closeSync } from "fs";
import { randomUUID } from "crypto";
import { join, resolve, relative } from "path";
import { homedir, tmpdir } from "os";
import type { Message, SerializedExploreCache } from "../core/types.js";
import { hasErrnoCode, safeTruncate } from "../tools/validate.js";
import { printWarning } from "../ui/ui.js";

// ── Constants ──

/**
 * Resolve the sessions directory path. `homedir()` can throw when
 * HOME/USERPROFILE is unset (common in containerized/CI environments).
 * This was already handled in `config.ts` (improvement #30), but session.ts
 * called it at module scope without protection — if it threw, the entire
 * module failed to import, crashing the process before the REPL started.
 * Falls back to a temp-dir-based path so session persistence degrades
 * gracefully rather than crashing.
 */
function getSessionsDir(): string {
  try {
    return join(homedir(), ".codingagent", "sessions");
  } catch {
    // Fall back to a subdirectory of the OS temp directory. Sessions
    // saved here may not survive reboots (temp is often cleared), but
    // that's better than crashing the entire process.
    return join(tmpdir(), ".codingagent", "sessions");
  }
}

const SESSIONS_DIR = getSessionsDir();
const MAX_SESSIONS = 50; // Keep at most 50 sessions on disk

/**
 * Monotonic counter for temp file uniqueness within save operations.
 * `Date.now()` has millisecond resolution, so two rapid auto-saves within the
 * same millisecond (e.g., triggered by concurrent tool completions or a manual
 * /save immediately after an auto-save) would generate identical temp file
 * names, causing the second `writeFileSync` to overwrite the first's in-flight
 * temp file — producing corrupt JSON if the writes interleave. The counter
 * guarantees uniqueness within a single process. Same pattern as the fix in
 * write.ts and edit.ts (improvement #26).
 */
let saveTmpCounter = 0;

// ── Types ──

export interface SessionMetadata {
  id: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  messageCount: number;
  cwd: string;
  model: string;
  /** First user message (preview) */
  preview: string;
  /** Estimated tokens at save time */
  estimatedTokens: number;
}

export interface SavedSession {
  version: 1;
  metadata: SessionMetadata;
  messages: Message[];
  sessionState: {
    turnCount: number;
    totalApiDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    history: { timestamp: number; text: string }[];
  };
  /**
   * Serialized explore cache (Read entries only) for persistence across
   * sessions. Optional — absent in older session files. On restore, entries
   * are validated against current file mtimes, so stale entries are
   * automatically discarded.
   */
  exploreCache?: SerializedExploreCache;
}

// ── Helpers ──

function ensureSessionsDir(): void {
  // Use `recursive: true` directly — it's a no-op when the directory already
  // exists, avoiding the TOCTOU race of check-then-create where another
  // process could delete the directory between `existsSync` and `mkdirSync`.
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * Resolve a session ID to a file path, with path traversal protection.
 * Ensures the resolved path stays within SESSIONS_DIR — rejects IDs
 * containing "..", path separators, or other characters that could escape
 * the sessions directory (e.g., a crafted "/resume ../../etc/passwd").
 */
function sessionFilePath(id: string): string {
  // Reject IDs that would produce filenames exceeding filesystem limits.
  // Windows has a 260-char total path limit; most Unix filesystems cap at
  // 255 chars per component. Our generated IDs are ~20 chars, so 200 is
  // generous for user-provided partial matches while preventing ENAMETOOLONG.
  if (id.length > 200) {
    throw new Error(`Session ID is too long (${id.length} chars, max 200).`);
  }
  // Reject IDs with path separators, traversal sequences, or null bytes.
  // Null bytes (\0) can truncate paths on some platforms/drivers, potentially
  // causing writes to unintended locations (e.g., "safe\0../../etc/passwd"
  // resolves to "safe" on the filesystem while passing the regex check).
  if (/[/\\]|\.\.|\0/.test(id)) {
    throw new Error(`Invalid session ID: ${id}`);
  }
  const resolved = resolve(SESSIONS_DIR, `${id}.json`);
  // Belt-and-suspenders: verify the resolved path is still within SESSIONS_DIR
  const rel = relative(SESSIONS_DIR, resolved);
  if (rel.startsWith("..") || resolve(SESSIONS_DIR, rel) !== resolved) {
    throw new Error(`Invalid session ID: ${id}`);
  }
  return resolved;
}

/**
 * Generate a short, human-friendly session ID.
 * Format: YYYYMMDD-HHMMSS-XXXX (date-time + 4 random chars)
 */
export function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHmmss
  const rand = randomUUID().slice(0, 4);
  return `${date}-${rand}`;
}

/**
 * Extract a preview string from messages (first user message, truncated).
 * Defensively handles non-array content to prevent crashes on corrupt session data.
 */
function extractPreview(messages: Message[]): string {
  for (const msg of messages) {
    if (msg.role === "user") {
      let text: string;
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b): b is { type: "text"; text: string } =>
            b != null && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join(" ");
      } else {
        // Corrupt content (e.g., null, number, or non-array object from
        // a hand-edited or corrupted session file). Skip this message
        // rather than crashing — there may be a valid user message later.
        continue;
      }
      const trimmed = text.trim();
      if (!trimmed) continue;
      // Skip compaction summary placeholders — after auto-compaction, the
      // first user message becomes "[Previous conversation summary] ..."
      // which replaces the original user prompt in session listings. This
      // makes the /sessions list useless for identifying sessions since
      // every compacted session shows the summary prefix instead of what
      // the user actually asked. Skip these and keep looking for a real
      // user message further in the conversation.
      if (trimmed.startsWith("[Previous conversation summary]") ||
          trimmed.startsWith("[Previous conversation was lost")) {
        continue;
      }
      return safeTruncate(trimmed, 100);
    }
  }
  return "(empty session)";
}

// ── Core API ──

/**
 * Save a session to disk.
 *
 * Errors are caught and logged rather than thrown, because session saving
 * is non-critical — a disk-full or permission error during auto-save
 * should not crash the REPL or lose the user's in-memory conversation.
 */
export function saveSession(
  id: string,
  messages: Message[],
  sessionState: SavedSession["sessionState"],
  cwd: string,
  model: string,
  estimatedTokens: number,
  exploreCache?: SerializedExploreCache
): boolean {
  try {
    ensureSessionsDir();

    const existing = loadSessionRaw(id);
    const createdAt = existing?.metadata.createdAt ?? Date.now();

    const saved: SavedSession = {
      version: 1,
      metadata: {
        id,
        createdAt,
        updatedAt: Date.now(),
        turnCount: sessionState.turnCount,
        messageCount: messages.length,
        cwd,
        model,
        preview: extractPreview(messages),
        estimatedTokens,
      },
      messages,
      sessionState,
      exploreCache,
    };

    // Write atomically: write to a temp file then rename. This prevents
    // corrupt session files if the process crashes mid-write (e.g., OOM,
    // kill signal, disk full after partial write). On most filesystems,
    // rename() is atomic within the same directory.
    //
    // Use a unique temp file name (pid + timestamp) to prevent corruption
    // when two processes (e.g., two terminal tabs) try to save the same
    // session simultaneously — both writing to the same `.tmp` file would
    // interleave their writes, producing corrupt JSON.
    const targetPath = sessionFilePath(id);
    const tempPath = targetPath + `.tmp.${process.pid}.${Date.now()}.${saveTmpCounter++}`;
    try {
      writeFileSync(tempPath, JSON.stringify(saved), "utf-8");
      renameSync(tempPath, targetPath);
    } catch (writeErr: unknown) {
      // Clean up the orphaned temp file on failure (e.g., renameSync fails
      // due to cross-device rename or permissions). Without this, the temp
      // file lingers until cleanupTempFiles() runs 60+ seconds later.
      try { unlinkSync(tempPath); } catch { /* best-effort */ }
      throw writeErr;
    }
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Emit a warning rather than crashing — the user's in-memory session
    // is still intact and they can continue working.
    printWarning(`Failed to save session ${id}: ${msg}`);
    return false;
  }
}

/**
 * Validate that a parsed JSON object has the required shape of a SavedSession.
 * Returns true if all required fields are present and have correct types.
 * This prevents crashes when loading corrupt or hand-edited session files.
 */
function isValidSessionShape(raw: unknown): raw is SavedSession {
  if (raw == null || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (!Array.isArray(obj.messages)) return false;
  // Validate individual messages — previously the array was only checked with
  // `Array.isArray`, so `messages: [null, 42, "hello"]` would pass validation
  // and crash downstream code that accesses `msg.role` and `msg.content`.
  // We only validate the basic shape (role + content existence) rather than
  // deep-validating all content blocks, which would be brittle against API
  // version changes.  A message with the right shape but corrupt content
  // blocks will be caught by the per-block guards already in estimateTokens,
  // summarizeContent, and extractPreview.
  for (const msg of obj.messages) {
    if (msg == null || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;
    if (m.role !== "user" && m.role !== "assistant") return false;
    // content must be a string or an array (of content blocks)
    if (typeof m.content !== "string" && !Array.isArray(m.content)) return false;
  }
  // Validate metadata
  const meta = obj.metadata;
  if (meta == null || typeof meta !== "object") return false;
  const m = meta as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.createdAt !== "number" ||
      typeof m.updatedAt !== "number" || typeof m.cwd !== "string") return false;
  // Validate `model` — it's used by /resume to set `config.model` (line ~679
  // in index.ts). Without this check, a corrupt session file with `"model": 42`
  // or `"model": null` would pass validation and be assigned to `config.model`,
  // causing the next API call to fail with a confusing "model not found" error
  // or a JSON serialization issue. We require it to be a string if present;
  // older session files may not have the field at all (undefined is allowed).
  if (m.model !== undefined && typeof m.model !== "string") return false;
  // Reject NaN/Infinity in metadata timestamps — same rationale as sessionState
  // fields below. NaN timestamps would break sort ordering in listSessions()
  // (NaN comparisons always return false, producing unstable sort results).
  if (!Number.isFinite(m.createdAt) || !Number.isFinite(m.updatedAt)) return false;
  // Reject NaN/Infinity in `estimatedTokens` — this field is used by
  // `formatSessionEntry()` which calls `NaN.toLocaleString()`, producing the
  // string `"NaN"`. The result is `"~NaN tok"` in `/sessions` output — confusing
  // but not crashing. However, it's worth rejecting here because the same NaN
  // propagates into `saveSession()` when the session is re-saved (line ~208:
  // `estimatedTokens` is copied from the loaded session metadata), persisting
  // the corruption into the re-written session file. The field is optional
  // (older sessions may lack it), so only reject non-finite number values.
  if (typeof m.estimatedTokens === "number" && !Number.isFinite(m.estimatedTokens)) return false;
  // Validate sessionState
  const state = obj.sessionState;
  if (state == null || typeof state !== "object") return false;
  const s = state as Record<string, unknown>;
  if (typeof s.turnCount !== "number") return false;
  // Reject NaN, Infinity, and -Infinity in numeric sessionState fields.
  // `typeof NaN === "number"` is true in JavaScript, so the `typeof` check
  // above passes for NaN. A hand-edited or corrupted session file with
  // `"turnCount": NaN` would then propagate through the system:
  //   - `session.turnCount++` → NaN
  //   - `shouldAutoSave(NaN - lastSaveTurn >= 1)` → always false
  //   - Auto-save never triggers again, risking data loss on crash
  // Same risk applies to token/duration counters used in /status cost estimates.
  if (!Number.isFinite(s.turnCount)) return false;
  if (typeof s.totalInputTokens === "number" && !Number.isFinite(s.totalInputTokens)) return false;
  if (typeof s.totalOutputTokens === "number" && !Number.isFinite(s.totalOutputTokens)) return false;
  if (typeof s.totalApiDurationMs === "number" && !Number.isFinite(s.totalApiDurationMs)) return false;
  // Validate history field if present. The field is optional (older sessions
  // predate it), but when it exists it must be an array — not a string, number,
  // or other type from a corrupt/hand-edited file. Without this check,
  // `"history": 42` passes validation and crashes on resume when the code does
  // `Array.isArray(ss.history) ? ss.history : []` (which works), but a corrupt
  // value like `"history": {"length": 2}` would pass `Array.isArray` check as
  // false and silently drop all history. More importantly, validating here lets
  // us catch corruption early with a clear "invalid structure" warning instead
  // of mysterious runtime errors.
  if (s.history !== undefined && !Array.isArray(s.history)) return false;
  return true;
}

/**
 * Load a raw session from disk (internal).
 * Returns null if the file doesn't exist, has an invalid shape, or fails to
 * parse. Parse failures are logged as warnings so corrupted session files can
 * be debugged instead of silently appearing as "Session not found."
 */
function loadSessionRaw(id: string): SavedSession | null {
  try {
    const filePath = sessionFilePath(id);
    // Read directly without existsSync — the previous existsSync + readFileSync
    // pattern is a TOCTOU race: the file can be deleted (by pruning, another
    // process, or the user) between the check and the read, causing an ENOENT
    // crash in readFileSync that propagated to the catch block as a confusing
    // "Failed to load session" warning for a legitimately absent file. Now we
    // just try reading and handle ENOENT as "not found" (return null silently).
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (readErr: unknown) {
      // ENOENT = file doesn't exist — this is normal, not a warning
      if (hasErrnoCode(readErr) && readErr.code === "ENOENT") {
        return null;
      }
      throw readErr; // re-throw other errors (EACCES, etc.) to the outer catch
    }

    const raw = JSON.parse(content);
    if (!isValidSessionShape(raw)) {
      printWarning(`Session file ${id} has invalid structure — ignoring.`);
      return null;
    }
    return raw;
  } catch (err: unknown) {
    // Log a warning so the user/developer can diagnose corruption instead of
    // getting a silent "Session not found" for a file that exists on disk.
    const msg = err instanceof Error ? err.message : String(err);
    printWarning(`Failed to load session ${id}: ${msg}`);
    return null;
  }
}

/**
 * Load a session by ID.
 */
export function loadSession(id: string): SavedSession | null {
  return loadSessionRaw(id);
}

/**
 * Extract just the metadata from a session JSON file without parsing the
 * entire file. Session files can be large (megabytes of conversation history),
 * but we only need the small `"metadata":{…}` block for listing/pruning.
 *
 * Strategy: read only the first ~4 KB of the file (the metadata block is
 * always near the start, right after `"version":1`), find the `"metadata":{`
 * substring, then extract and parse just that object. This avoids reading
 * and parsing the remaining megabytes of conversation messages.
 * Falls back to null if the fast path fails (caller does full parse).
 */
const METADATA_READ_SIZE = 4096;

function extractMetadataFast(filePath: string): SessionMetadata | null {
  let fd = -1;
  try {
    // Read only the first 4KB — more than enough for the metadata block
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(METADATA_READ_SIZE);
    const bytesRead = readSync(fd, buf, 0, METADATA_READ_SIZE, 0);
    closeSync(fd);
    fd = -1;

    // Trim trailing incomplete UTF-8 sequences at the buffer boundary.
    // UTF-8 multi-byte characters (emojis, CJK, accented chars) can span
    // the 4096-byte read boundary. When this happens, Buffer.toString("utf-8")
    // replaces the incomplete trailing bytes with U+FFFD (replacement char),
    // which can land inside the metadata JSON string and cause JSON.parse to
    // produce garbled field values — or, if the truncation splits a backslash
    // escape sequence, cause a parse failure that triggers the expensive full
    // parse fallback.
    //
    // Walk backward from the end: if the last byte is a UTF-8 continuation
    // byte (0x80–0xBF) or a multi-byte leader whose character isn't complete,
    // shrink bytesRead to exclude the partial character.
    let safeBytesRead = bytesRead;
    if (safeBytesRead > 0 && safeBytesRead === METADATA_READ_SIZE) {
      // Only needed when we hit the read buffer limit (partial read)
      for (let i = safeBytesRead - 1; i >= safeBytesRead - 4 && i >= 0; i--) {
        const byte = buf[i];
        if ((byte & 0x80) === 0) {
          // ASCII byte — no truncation issue
          break;
        }
        if ((byte & 0xc0) === 0xc0) {
          // Found a multi-byte leader — check if the full character fits
          const expectedLen =
            (byte & 0xf8) === 0xf0 ? 4 :
            (byte & 0xf0) === 0xe0 ? 3 :
            (byte & 0xe0) === 0xc0 ? 2 : 1;
          if (i + expectedLen > safeBytesRead) {
            // Incomplete character — trim it
            safeBytesRead = i;
          }
          break;
        }
        // continuation byte (10xxxxxx) — keep scanning backward for the leader
      }
    }

    const raw = buf.toString("utf-8", 0, safeBytesRead);

    // Strip UTF-8 BOM (Byte Order Mark) if present. Some text editors (e.g.,
    // Notepad on older Windows versions) prepend U+FEFF to UTF-8 files. If a
    // session file was manually edited with such an editor, the BOM prefix
    // would cause the `startsWith('{"version":1')` check below to fail,
    // falling through to the expensive full-parse path for every call to
    // listSessions(). The full parse still works (JSON.parse ignores BOM in
    // some runtimes), but it negates the performance benefit of the fast path.
    const content = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;

    // Quick version check — the file must start with {"version":1
    if (!content.startsWith('{"version":1')) return null;

    // Find the metadata key
    const metaStart = content.indexOf('"metadata":');
    if (metaStart === -1) return null;

    // Find the opening brace of the metadata object
    const braceStart = content.indexOf("{", metaStart + 11);
    if (braceStart === -1) return null;

    // Walk the string to find the matching closing brace, counting depth.
    // The metadata object is small and flat (no nested objects), so this
    // terminates quickly even for multi-MB session files.
    let depth = 0;
    let braceEnd = -1;
    let inString = false;
    let escaped = false;
    for (let i = braceStart; i < content.length; i++) {
      const ch = content.charCodeAt(i);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === 0x5c /* \ */) {
        if (inString) escaped = true;
        continue;
      }
      if (ch === 0x22 /* " */) {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === 0x7b /* { */) depth++;
      else if (ch === 0x7d /* } */) {
        depth--;
        if (depth === 0) {
          braceEnd = i;
          break;
        }
      }
    }

    if (braceEnd === -1) return null;

    const metaJson = content.substring(braceStart, braceEnd + 1);
    const meta = JSON.parse(metaJson) as SessionMetadata;

    // Basic shape validation — must match the full validator's checks for
    // the fields used by listSessions(). In particular, reject NaN/Infinity
    // in `updatedAt`: `typeof NaN === "number"` passes the typeof check, but
    // NaN causes unstable sort ordering in listSessions() because
    // `NaN - validNumber` is NaN, and comparison functions returning NaN
    // cause Array.sort to produce implementation-dependent orderings.
    // The full `isValidSessionShape` validator already checks this, but the
    // fast path bypasses it — so a corrupt session file with `"updatedAt": NaN`
    // would produce inconsistent session list ordering on every invocation.
    //
    // Also validate `createdAt` — a corrupt `createdAt: NaN` passes the fast
    // path and flows into `saveSession()` (line ~165: `const createdAt =
    // existing?.metadata.createdAt ?? Date.now()`), persisting the NaN into
    // the re-saved file. It also reaches `formatSessionEntry()` where
    // `new Date(NaN).toLocaleDateString()` produces "Invalid Date", and into
    // any display that shows session creation time. The full validator already
    // checks `Number.isFinite(m.createdAt)`, but this fast path was missing it.
    if (typeof meta.id !== "string" ||
        typeof meta.createdAt !== "number" || !Number.isFinite(meta.createdAt) ||
        typeof meta.updatedAt !== "number" || !Number.isFinite(meta.updatedAt)) {
      return null;
    }

    // Validate turnCount and messageCount — without this, a corrupt session
    // file with `"turnCount": NaN` passes the fast path and shows "NaN turns"
    // in `/sessions` output (`NaN.toLocaleString()` → "NaN", and `NaN !== 1`
    // → true so the pluralization suffix is "s", producing "NaN turns").
    // Similarly, `"messageCount": NaN` propagates into token estimates and
    // resume logic. The full `isValidSessionShape` validator already checks
    // `Number.isFinite(s.turnCount)`, but the fast path bypasses it. Accept
    // non-number types (undefined from older session files) by only rejecting
    // `number` values that are NaN/Infinity.
    if (typeof meta.turnCount === "number" && !Number.isFinite(meta.turnCount)) return null;
    if (typeof meta.messageCount === "number" && !Number.isFinite(meta.messageCount)) return null;

    // Validate `estimatedTokens` — a corrupt value like `"estimatedTokens": NaN`
    // passes the fast path (which doesn't validate this field at all) and reaches
    // `formatSessionEntry()` where `NaN.toLocaleString()` produces the literal
    // string `"NaN"`, displaying `"~NaN tok"` in the `/sessions` listing. The
    // full `isValidSessionShape` validator also doesn't check this field (it only
    // validates required structural fields), so NaN propagates through both paths.
    // Accept `undefined`/`null` (older sessions may lack the field) but reject
    // non-finite number values. A negative value is technically invalid too, but
    // harmless — it just shows a negative token count, which is obviously wrong
    // but doesn't crash anything.
    if (typeof meta.estimatedTokens === "number" && !Number.isFinite(meta.estimatedTokens)) return null;

    // Validate `model` — the fast path bypasses `isValidSessionShape` which
    // already checks `typeof m.model !== "string"` (line ~285). A corrupt
    // session file with `"model": 42` or `"model": true` would pass the fast
    // path and reach `formatSessionEntry()` where `meta.model.replace(...)` is
    // called (line ~688). Since `Number.prototype.replace` doesn't exist, this
    // throws `TypeError: (42).replace is not a function`, crashing the entire
    // `/sessions` listing. Accept `undefined` (older sessions may lack the
    // field) but reject non-string defined values.
    if (meta.model !== undefined && meta.model !== null && typeof meta.model !== "string") return null;

    // Validate `cwd` — the fast path bypasses `isValidSessionShape` which
    // doesn't check `cwd` at all. A corrupt session file with `"cwd": 42` or
    // `"cwd": true` would pass the fast path and reach `formatSessionEntry()`
    // where `meta.cwd.replace(/\\/g, "/")` is called (line ~740). Since
    // `Number.prototype.replace` doesn't exist, this throws `TypeError:
    // (42).replace is not a function`, crashing the entire `/sessions` listing
    // for ALL sessions (the crash aborts the loop in the caller). Accept
    // `undefined`/`null` (older sessions may lack the field) but reject
    // non-string defined values. This is the same pattern as the `model`
    // validation above.
    if (meta.cwd !== undefined && meta.cwd !== null && typeof meta.cwd !== "string") return null;

    // Validate `preview` — the fast path bypasses `isValidSessionShape` (which
    // doesn't check `preview` at all). A corrupt session file with `"preview": 42`
    // or `"preview": [1,2,3]` would pass the fast path. While `formatSessionEntry`
    // defensively checks `typeof meta.preview === "string"` (line ~754), other
    // current or future call sites that consume the returned `SessionMetadata`
    // may not. For example, `extractPreview()` is only called from `saveSession()`
    // to generate the preview — when listing sessions via the fast path, the
    // `preview` field comes directly from the JSON file. A non-string `preview`
    // would cause `safeTruncate(meta.preview, 100)` to crash if called with a
    // number (since `safeTruncate` does `.length` on the input). Accept
    // `undefined`/`null` (older sessions may lack the field) but reject
    // non-string defined values — same pattern as `model` and `cwd` above.
    if (meta.preview !== undefined && meta.preview !== null && typeof meta.preview !== "string") return null;

    return meta;
  } catch {
    // Close the file descriptor if it was opened but not yet closed
    if (fd !== -1) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
    return null;
  }
}

/**
 * List all saved sessions, sorted by most recently updated.
 *
 * Uses {@link extractMetadataFast} to read only the metadata block from each
 * session file, avoiding the cost of parsing potentially large `messages`
 * arrays. Falls back to full parse for files where the fast path fails.
 */
export function listSessions(): SessionMetadata[] {
  ensureSessionsDir();

  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  const sessions: SessionMetadata[] = [];

  for (const file of files) {
    const filePath = join(SESSIONS_DIR, file);
    // Try fast metadata-only extraction first
    const meta = extractMetadataFast(filePath);
    if (meta) {
      sessions.push(meta);
      continue;
    }
    // Fall back to full parse for files with unusual formatting.
    // Guard against unexpectedly large files (e.g., non-session .json files
    // placed in the sessions directory manually) which could cause OOM during
    // JSON.parse.  Normal session files are typically 50 KB–5 MB; anything
    // above 50 MB is almost certainly not a session file.
    try {
      const fileSize = statSync(filePath).size;
      if (fileSize > 50 * 1024 * 1024) {
        // Skip files larger than 50 MB — not a session file
        continue;
      }
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      // Use isValidSessionShape for full structural validation — the previous
      // `raw.version === 1 && raw.metadata` check was too weak: it didn't
      // validate metadata shape (e.g., `{"version":1, "metadata":"oops"}` would
      // push a string into the SessionMetadata[] array) and didn't validate
      // messages at all, potentially hiding corrupt session files.
      if (isValidSessionShape(raw)) {
        sessions.push(raw.metadata);
      }
    } catch {
      // Skip corrupt or unreadable files
    }
  }

  // Sort by updatedAt descending (most recent first)
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

/**
 * Delete a session by ID.
 */
export function deleteSession(id: string): boolean {
  try {
    const filePath = sessionFilePath(id);
    // Use unlinkSync directly without existsSync — the previous check-then-delete
    // pattern is a TOCTOU race: the file can be deleted between existsSync and
    // unlinkSync (e.g., concurrent pruning). Handle ENOENT as "already gone".
    unlinkSync(filePath);
    return true;
  } catch (err: unknown) {
    // ENOENT means the file was already deleted — treat as "not found"
    if (hasErrnoCode(err) && err.code === "ENOENT") {
      return false;
    }
    // Other errors (EACCES, EPERM, etc.) — warn so the user knows pruning
    // failed for this session and can investigate (e.g., fix permissions).
    // Previously these were silently swallowed — the caller (e.g., pruneSessions)
    // interpreted `false` as "nothing to delete," and old sessions accumulated
    // indefinitely on systems with restrictive permissions.
    const msg = err instanceof Error ? err.message : String(err);
    printWarning(`Could not delete session ${id}: ${msg}`);
    return false;
  }
}

/**
 * Get the most recent session ID (if any).
 */
export function getLastSessionId(): string | null {
  const sessions = listSessions();
  return sessions.length > 0 ? sessions[0].id : null;
}

/**
 * Clean up orphaned `.tmp` files in the sessions directory.
 *
 * These can be left behind when the process crashes between
 * `writeFileSync(tempPath)` and `renameSync(tempPath, targetPath)`
 * in `saveSession()`. We remove any `.json.tmp` file older than
 * 60 seconds (a healthy write-rename cycle takes milliseconds).
 */
function cleanupTempFiles(): void {
  try {
    // Read directory contents directly without existsSync — the previous
    // existsSync + readdirSync pattern is a TOCTOU race: the directory
    // could be deleted between the existence check and the read. This
    // pattern was already fixed in loadSessionRaw, deleteSession, and
    // ensureSessionsDir elsewhere in this file. Handle ENOENT from
    // readdirSync as "directory doesn't exist" (early return).
    let files: string[];
    try {
      files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json.tmp") || /\.json\.tmp\.\d+\.\d+(\.\d+)?$/.test(f));
    } catch (readErr: unknown) {
      if (hasErrnoCode(readErr) && readErr.code === "ENOENT") return;
      throw readErr;
    }
    const now = Date.now();
    for (const file of files) {
      try {
        const fullPath = join(SESSIONS_DIR, file);
        const stat = statSync(fullPath);
        // Only remove temp files older than 60 seconds to avoid racing
        // with an in-progress atomic write from another process.
        if (now - stat.mtimeMs > 60_000) {
          unlinkSync(fullPath);
        }
      } catch {
        // Best-effort: skip files that vanish or can't be stat'd
      }
    }
  } catch {
    // Best-effort: ignore errors (e.g., SESSIONS_DIR unreadable)
  }
}

/**
 * Prune old sessions beyond MAX_SESSIONS and clean up temp files.
 */
export function pruneSessions(): number {
  // Clean up stale .tmp files from previous crashed writes
  cleanupTempFiles();

  const sessions = listSessions();
  let pruned = 0;

  if (sessions.length > MAX_SESSIONS) {
    const toDelete = sessions.slice(MAX_SESSIONS);
    for (const meta of toDelete) {
      if (deleteSession(meta.id)) {
        pruned++;
      }
    }
  }

  return pruned;
}

/**
 * Format a session metadata entry for display.
 *
 * Includes the model name (shortened to the last path segment for readability,
 * e.g., "claude-sonnet-4-20250514" instead of the full API model string) so
 * users can distinguish sessions run with different models in `/sessions` and
 * `/resume` listings. Previously the model was omitted, making it impossible
 * to tell apart sessions that used different model tiers.
 */
export function formatSessionEntry(meta: SessionMetadata, index: number): string {
  const date = new Date(meta.updatedAt);
  const timeStr = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const turns = `${meta.turnCount} turn${meta.turnCount !== 1 ? "s" : ""}`;
  const tokens = meta.estimatedTokens != null && Number.isFinite(meta.estimatedTokens) ? `~${meta.estimatedTokens.toLocaleString()} tok` : "? tok";
  // Show a short model identifier — strip any "anthropic/" or similar provider
  // prefix that some proxy setups include, keeping just the model name.
  const modelStr = meta.model
    ? meta.model.replace(/^.*\//, "")
    : "unknown";
  // Guard against non-string `preview` — the `extractMetadataFast` path
  // doesn't validate the `preview` field, so corrupt/older session files
  // can produce `preview: undefined`, `preview: null`, or `preview: 42`.
  // Without this guard, `meta.preview.length` throws `TypeError: Cannot
  // read properties of undefined (reading 'length')`, crashing the
  // `/sessions` listing for ALL sessions (since the crash aborts the loop
  // in the caller). The same issue affects `meta.preview` access on line ~758
  // in index.ts's `/resume` handler. Defaulting to "(no preview)" makes
  // the listing degrade gracefully for corrupt entries while keeping all
  // other sessions visible.
  const rawPreview = typeof meta.preview === "string" ? meta.preview : "(no preview)";
  const preview = rawPreview.length > 50 ? safeTruncate(rawPreview, 47) + "…" : rawPreview;
  // Show a short CWD so the user can distinguish sessions from different projects.
  // Without this, sessions from `/home/user/project-a` and `/home/user/project-b`
  // look identical in `/sessions` output — the user must `/resume` each one to
  // discover which project it was for. Extract just the last path segment (the
  // project directory name), which is usually the most informative part and fits
  // in the compact display. Fall back to the full path for root-level sessions.
  const cwdShort = meta.cwd
    ? meta.cwd.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || meta.cwd
    : "";
  const cwdStr = cwdShort ? ` in ${cwdShort}` : "";
  return `  ${String(index + 1).padStart(2)}. [${meta.id}] ${timeStr} | ${modelStr} | ${turns} | ${tokens}${cwdStr}\n      ${preview}`;
}
