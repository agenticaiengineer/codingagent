/**
 * UI module — Pure ANSI terminal rendering with zero external dependencies.
 *
 * Provides color utilities, spinners, formatters, and display components for
 * the CodingAgent REPL. All output is plain-text safe when NO_COLOR is set
 * or the terminal is dumb/non-TTY.
 */

import type { AppConfig } from "../core/types.js";
import { emitKeypressEvents, type Interface as ReadlineInterface, type Key as ReadlineKey, moveCursor, cursorTo, clearScreenDown } from "readline";
import { Transform } from "stream";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { safeTruncate } from "../tools/validate.js";
import { getRegisteredCommands, getRegisteredSkills, getAllCommandNames, getArgumentProvider, type ArgumentSuggestion } from "./commands.js";

// ── ANSI Color Utilities ──────────────────────────────────────────────────────

/**
 * Whether color output is suppressed. Respects the NO_COLOR convention
 * (https://no-color.org/) and detects dumb terminals.
 */
const colorsDisabled: boolean =
  "NO_COLOR" in process.env ||
  process.env.TERM === "dumb" ||
  !process.stdout.isTTY;

/** Wrap text in an ANSI escape sequence, or return it unchanged when colors are off. */
function ansi(open: string, close: string, text: string): string {
  if (colorsDisabled) return text;
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

/** Dim (faint) text. */
export function dim(text: string): string {
  return ansi("2", "22", text);
}

/** Bold text. */
export function bold(text: string): string {
  return ansi("1", "22", text);
}

/** Cyan text. */
export function cyan(text: string): string {
  return ansi("36", "39", text);
}

/** Green text. */
export function green(text: string): string {
  return ansi("32", "39", text);
}

/** Red text. */
export function red(text: string): string {
  return ansi("31", "39", text);
}

/** Yellow text. */
export function yellow(text: string): string {
  return ansi("33", "39", text);
}

/** Magenta text. */
export function magenta(text: string): string {
  return ansi("35", "39", text);
}

/** Gray (bright-black) text. */
export function gray(text: string): string {
  return ansi("90", "39", text);
}

/** White text. */
export function white(text: string): string {
  return ansi("37", "39", text);
}

// ── Spinner ───────────────────────────────────────────────────────────────────

/** Braille animation frames for the spinner. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Spinner interval in milliseconds. */
const SPINNER_INTERVAL_MS = 80;

/**
 * Global counter of active spinners that have hidden the cursor.
 * Used by the `process.on('exit')` handler to restore the cursor
 * if the process exits (crash, unhandled rejection, SIGKILL, etc.)
 * while a spinner is active.
 */
let activeSpinnerCount = 0;

// Register a single process-wide 'exit' handler to restore the cursor.
// 'exit' fires synchronously right before the process terminates, even
// on crashes or unhandled exceptions, so this is the last chance to fix
// the terminal. The handler is safe to register multiple times (it's
// a no-op when no spinners are active).
let exitHandlerRegistered = false;
function ensureExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on("exit", () => {
    if (activeSpinnerCount > 0 && (process.stderr.isTTY ?? false)) {
      // Restore cursor visibility — the only thing we can do synchronously
      process.stderr.write("\x1b[?25h");
    }
  });
}

/**
 * A non-blocking Braille spinner that writes to stderr so it never
 * contaminates piped stdout. Degrades to a static message on non-TTY.
 *
 * If the process exits unexpectedly while a spinner is active, a
 * process-wide 'exit' handler restores the terminal cursor so it
 * doesn't remain permanently hidden.
 *
 * @example
 * ```ts
 * const spinner = new Spinner("Thinking…");
 * spinner.start();
 * // … async work …
 * spinner.stop();
 * ```
 */
export class Spinner {
  private message: string;
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isTTY: boolean;
  /** Whether this spinner instance has hidden the cursor (and not yet restored it). */
  private cursorHidden = false;
  /** Whether start() has been called (and stop() has not yet been called).
   *  Used to guard stop() against emitting ANSI escape sequences when the
   *  spinner was never started, which would otherwise write a spurious
   *  carriage-return + line-clear + show-cursor sequence to stderr. */
  private started = false;

  constructor(message = "Working…") {
    this.message = message;
    this.isTTY = process.stderr.isTTY ?? false;
  }

  /** Begin the animation. Safe to call multiple times (no-ops if already running). */
  start(): void {
    if (this.timer) return;

    this.started = true;

    if (!this.isTTY) {
      // Non-TTY: emit a single static line and return
      process.stderr.write(`${this.message}\n`);
      return;
    }

    // Ensure the exit handler is registered before hiding the cursor
    ensureExitHandler();

    // Hide cursor
    process.stderr.write("\x1b[?25l");
    this.cursorHidden = true;
    activeSpinnerCount++;
    this.render();

    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.render();
    }, SPINNER_INTERVAL_MS);

    // Don't keep the process alive just for the spinner
    this.timer.unref();
  }

  /** Update the spinner message while it's running. */
  update(message: string): void {
    this.message = message;
    if (this.isTTY && this.timer) {
      this.render();
    }
  }

  /** Stop the animation and clear the spinner line. No-ops if never started. */
  stop(finalMessage?: string): void {
    if (!this.started) {
      // stop() was called without start() — nothing to clean up.
      // Writing ANSI escape sequences here would clear the current line
      // and emit a show-cursor command for no reason.
      return;
    }
    this.started = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (!this.isTTY) {
      if (finalMessage) {
        process.stderr.write(`${finalMessage}\n`);
      }
      return;
    }

    // Clear the spinner line
    process.stderr.write("\r\x1b[K");

    if (finalMessage) {
      process.stderr.write(`${finalMessage}\n`);
    }

    // Show cursor and update global tracker
    process.stderr.write("\x1b[?25h");
    if (this.cursorHidden) {
      this.cursorHidden = false;
      activeSpinnerCount = Math.max(0, activeSpinnerCount - 1);
    }
  }

  /** Render the current frame to stderr. */
  private render(): void {
    const frame = cyan(SPINNER_FRAMES[this.frameIndex]);
    // Truncate the message to fit within the terminal width to prevent
    // line wrapping. When the spinner text exceeds the terminal width, it
    // wraps to the next line. On the next render, `\r\x1b[K` moves to
    // column 0 of the *wrapped* line and clears it, but the first part of
    // the old message on the previous line remains — visible as "ghost text"
    // that accumulates with every frame update. The frame character + space
    // takes 2 visible columns, so the message gets `cols - 2` characters.
    // On non-TTY (shouldn't reach here, but defensive) or if columns is
    // unavailable, skip truncation — the fallback is the original behavior.
    let msg = this.message;
    const cols = process.stderr.columns;
    if (cols && cols > 4) {
      // 2 for the spinner frame + space, 1 for safety margin
      const maxMsgLen = cols - 3;
      if (msg.length > maxMsgLen) {
        msg = safeTruncate(msg, maxMsgLen - 1) + "…";
      }
    }
    process.stderr.write(`\r\x1b[K${frame} ${msg}`);
  }
}

// ── Duration Formatting ───────────────────────────────────────────────────────

/**
 * Format a duration in milliseconds into a human-readable string.
 *
 * - `< 1000ms` → `"123ms"`
 * - `< 60s`    → `"4.2s"`
 * - `< 1h`     → `"2m 15s"`
 * - `≥ 1h`     → `"1h 30m"`
 *
 * Guards against NaN and Infinity, which can propagate from corrupt session
 * data, `performance.now()` edge cases, or arithmetic on undefined values.
 * Without this guard, NaN falls through all `<` comparisons (they all return
 * false) and produces garbled output like "NaNh NaNm".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;

  if (ms < 1000) {
    // Show "<1ms" for sub-millisecond operations (e.g., cache hits, no-op
    // tools) instead of "0ms" which looks like the timer didn't work.
    if (ms < 1 && ms > 0) return "<1ms";
    return `${Math.round(ms)}ms`;
  }

  const totalSeconds = ms / 1000;

  if (totalSeconds < 60) {
    // Use floor-based rounding to prevent "60.0s" at the boundary.
    // `toFixed(1)` rounds 59.95 → "60.0", which is confusing because it
    // looks like a full minute displayed in seconds. By truncating to one
    // decimal place (floor × 10 / 10), 59.95 → "59.9s", and 60.0+ falls
    // through to the proper "1m 0s" format below.
    const truncated = Math.floor(totalSeconds * 10) / 10;
    if (truncated < 60) {
      return `${truncated.toFixed(1)}s`;
    }
    // truncated === 60.0 falls through to the minute format
  }

  // Use Math.floor on total seconds to avoid rounding up into "0m 60s".
  // E.g. totalSeconds=59.6 → floor(59.6)=59 → 0m 59s (not 0m 60s).
  const totalFloor = Math.floor(totalSeconds);
  const hours = Math.floor(totalFloor / 3600);
  const minutes = Math.floor((totalFloor % 3600) / 60);
  const seconds = totalFloor % 60;

  // For sessions running 60+ minutes, "62m 15s" is hard to parse at a
  // glance. Show "1h 2m" instead — seconds are dropped since at this
  // timescale they add noise without useful precision.
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return `${minutes}m ${seconds}s`;
}

// ── Byte Formatting ───────────────────────────────────────────────────────────

/**
 * Format a byte count into a human-readable string.
 *
 * - `< 1024`      → `"512 B"`
 * - `< 1048576`   → `"15.3 KB"`
 * - `≥ 1048576`   → `"2.1 MB"`
 *
 * Guards against NaN and Infinity, which can propagate from corrupt session
 * data or arithmetic on undefined file sizes. Without this guard, NaN falls
 * through all `<` comparisons and produces "NaN MB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Box Drawing ───────────────────────────────────────────────────────────────

/** Default box width (characters). */
const BOX_WIDTH = 60;

/**
 * Draw a Unicode box around content with an optional title.
 *
 * ```
 * ╭─ Title ─────────────────────────────────╮
 * │ Line 1                                  │
 * │ Line 2                                  │
 * ╰─────────────────────────────────────────╯
 * ```
 */
export function formatBox(title: string, content: string, width = BOX_WIDTH): string {
  // Clamp innerWidth to at least 1 to prevent RangeError from "─".repeat()
  // with a negative argument. width < 2 can't happen with our BOX_WIDTH default
  // (60) or explicit callers (56, 58), but this guards against future callers
  // or unit tests passing a small width. "─".repeat(-1) throws RangeError.
  const innerWidth = Math.max(1, width - 2); // subtract left/right border chars
  const lines = content.split("\n");

  // ── Top border ──
  let top: string;
  if (title) {
    const titleStr = ` ${title} `;
    // Use visible (ANSI-stripped) length so color codes don't inflate the width
    const visibleTitleLen = stripAnsi(titleStr).length;
    const remaining = Math.max(0, innerWidth - visibleTitleLen - 1);
    top = `╭─${titleStr}${"─".repeat(remaining)}╮`;
  } else {
    top = `╭${"─".repeat(innerWidth)}╮`;
  }

  // ── Content rows ──
  const rows = lines.map((line) => {
    // Strip ANSI sequences to compute visible length
    const visible = stripAnsi(line);
    if (visible.length > innerWidth) {
      // Truncate to fit within the box, preserving ANSI codes.
      // Reserve 1 char for the ellipsis indicator.
      const truncated = ansiAwareTruncate(line, innerWidth - 1);
      return `│${truncated}…│`;
    }
    const pad = innerWidth - visible.length;
    return `│${line}${" ".repeat(pad)}│`;
  });

  // ── Bottom border ──
  const bottom = `╰${"─".repeat(innerWidth)}╯`;

  return [top, ...rows, bottom].join("\n");
}

/**
 * Strip ANSI escape sequences for accurate visible-length calculations.
 * Handles SGR (colors/styles), CSI sequences (cursor movement, DEC private
 * modes), and OSC sequences.
 *
 * The CSI pattern includes an optional `?` prefix to match DEC private mode
 * sequences like `\x1b[?25h` (show cursor) and `\x1b[?25l` (hide cursor).
 * Without the `?`, these sequences survive stripping, adding invisible
 * characters to the visible-length calculation — causing misaligned box
 * borders in `formatBox` and incorrect truncation in `formatToolResult`.
 *
 * The parameter byte range `[0-9;:?]` covers:
 *   - `0-9;` — standard CSI parameter bytes (colors, positions)
 *   - `:`    — sub-parameter separator for 256-color/truecolor sequences
 *             (e.g., `\x1b[38:2:255:0:0m`)
 *   - `?`   — DEC private mode prefix (e.g., `\x1b[?25h`)
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;:?]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

/**
 * Truncate a string to a maximum number of *visible* characters,
 * preserving (and not counting) ANSI escape sequences.
 *
 * Returns the raw substring (with ANSI codes intact) that renders as at
 * most `maxVisible` printable characters. Any open ANSI color/style is
 * properly terminated with a reset sequence.
 *
 * Uses a sticky regex to avoid O(n²) substring allocations — the regex
 * is tested at each position via `lastIndex` rather than slicing the string.
 *
 * The parameter byte range `[0-9;:?]` matches `stripAnsi` — without `:`
 * and `?`, truecolor sequences (e.g., `\x1b[38:2:255:0:0m`) and DEC
 * private mode sequences (e.g., `\x1b[?25h`) are not recognized as ANSI
 * escapes, causing their bytes to be counted as visible characters. This
 * leads to premature truncation (the visible string is shorter than
 * `maxVisible`) and misaligned box borders in `formatBox`.
 */
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE_STICKY = /\x1b(?:\[[0-9;:?]*[A-Za-z]|\].*?\x07)/y;

function ansiAwareTruncate(text: string, maxVisible: number): string {
  let visible = 0;
  let i = 0;
  let hasAnsi = false;

  while (i < text.length && visible < maxVisible) {
    if (text.charCodeAt(i) === 0x1b) {
      // Potential ANSI escape — test with sticky regex at this position
      ANSI_SEQUENCE_STICKY.lastIndex = i;
      const match = ANSI_SEQUENCE_STICKY.exec(text);
      if (match) {
        hasAnsi = true;
        i += match[0].length;
        continue;
      }
    }
    // Handle surrogate pairs: a high surrogate (0xD800–0xDBFF) followed by a
    // low surrogate (0xDC00–0xDFFF) form a single visible character but occupy
    // 2 UTF-16 code units. Without this check, `i++` advances past the high
    // surrogate alone, and the next iteration counts the low surrogate as a
    // separate visible character — producing an incorrect visible count and
    // potentially splitting the pair at the truncation boundary (orphaning a
    // lone high surrogate that renders as U+FFFD).
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const nextCode = text.charCodeAt(i + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        // Surrogate pair — one visible character, two code units
        visible++;
        i += 2;
        continue;
      }
    }
    // Regular visible character (or lone surrogate — count as 1)
    visible++;
    i++;
  }

  const truncated = text.substring(0, i);

  // If the string contained ANSI codes, append a reset to avoid style leaking
  if (hasAnsi) {
    return truncated + "\x1b[0m";
  }
  return truncated;
}

// ── Tool Result Formatting ────────────────────────────────────────────────────

/**
 * Format a tool execution result inside a colored box.
 *
 * Successful results get a green header; errors get a red header.
 * Content is truncated to keep terminal output manageable.
 */
export function formatToolResult(
  toolName: string,
  content: string,
  durationMs?: number,
  isError = false
): string {
  // Errors (compiler output, stack traces, etc.) are more useful when shown
  // in full; normal output is truncated more aggressively to keep the terminal
  // clean.
  const MAX_PREVIEW_LINES = isError ? 24 : 12;
  const MAX_LINE_LENGTH = 56; // fits inside default box width

  const colorFn = isError ? red : green;
  const icon = isError ? "✗" : "✓";
  const durationStr = durationMs != null ? ` ${dim(formatDuration(durationMs))}` : "";
  const header = `${colorFn(icon)} ${bold(toolName)}${durationStr}`;

  // Truncate content for display
  const rawLines = content.split("\n");
  let displayLines = rawLines.slice(0, MAX_PREVIEW_LINES).map((line) => {
    const visibleText = stripAnsi(line);
    if (visibleText.length > MAX_LINE_LENGTH) {
      // Truncate based on visible length, not raw length.
      // Walk the raw string, tracking visible chars to find the cut point.
      const cutPoint = ansiAwareTruncate(line, MAX_LINE_LENGTH - 1);
      return ` ${cutPoint}…`;
    }
    return ` ${line}`;
  });

  if (rawLines.length > MAX_PREVIEW_LINES) {
    const remaining = rawLines.length - MAX_PREVIEW_LINES;
    // Show both line count and total size so the user knows how much was truncated
    const totalSize = content.length;
    const sizeStr =
      totalSize >= 1024
        ? `${(totalSize / 1024).toFixed(1)} KB`
        : `${totalSize} chars`;
    displayLines.push(` ${dim(`… ${remaining} more line${remaining === 1 ? "" : "s"} (${sizeStr} total)`)}`);
  }

  const body = displayLines.join("\n");
  return formatBox(header, body);
}

// ── Error Formatting ──────────────────────────────────────────────────────────

/** Well-known error patterns and their user-friendly descriptions. */
const ERROR_PATTERNS: ReadonlyArray<{ test: (msg: string) => boolean; label: string; hint: string }> = [
  {
    test: (msg) => /429|rate.?limit|too many requests/i.test(msg),
    label: "Rate Limited",
    hint: "Too many requests. Wait a moment and retry, or check your API plan limits.",
  },
  {
    test: (msg) => /401|unauthorized|invalid.*key|authentication/i.test(msg),
    label: "Authentication Failed",
    hint: "Check that ANTHROPIC_API_KEY is set and valid.",
  },
  {
    test: (msg) => /403|forbidden|permission/i.test(msg),
    label: "Permission Denied",
    hint: "Your API key may lack the required permissions for this operation.",
  },
  {
    test: (msg) => /abort|cancel/i.test(msg),
    label: "Aborted",
    hint: "The operation was cancelled (Ctrl+C or timeout).",
  },
  {
    test: (msg) => /timeout|ETIMEDOUT|ECONNABORTED/i.test(msg),
    label: "Timeout",
    hint: "The request timed out. Check your network connection or try again.",
  },
  {
    test: (msg) => /ENOTFOUND|ECONNREFUSED|network|fetch failed/i.test(msg),
    label: "Network Error",
    hint: "Cannot reach the API. Check your internet connection and ANTHROPIC_BASE_URL.",
  },
  {
    test: (msg) => /500|502|503|504|server error|internal/i.test(msg),
    label: "Server Error",
    hint: "The API server returned an error. This is usually transient — retry shortly.",
  },
  {
    test: (msg) => /context.*length|too.*long|max.*tokens/i.test(msg),
    label: "Context Too Long",
    hint: "The conversation is too large. Use /compact or /clear to reduce context.",
  },
];

/**
 * Format an error for display, with pattern matching for common error types
 * to provide actionable hints.
 */
export function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // Check if the error message already contains an embedded hint (e.g., from
  // loop.ts's apiErrorHint/networkErrorHint which append "\nHint: ..." to the
  // error string). If present, extract it so we can display it directly instead
  // of replacing it with a generic pattern-matched hint. Without this, the
  // message is truncated at 200 chars (cutting off the embedded hint), and
  // formatError adds its own less-specific hint — the user sees a duplicate,
  // less helpful hint while the original contextual one is lost.
  const hintIdx = message.indexOf("\nHint:");
  let mainMessage = message;
  let embeddedHint: string | null = null;
  if (hintIdx !== -1) {
    mainMessage = message.slice(0, hintIdx);
    embeddedHint = message.slice(hintIdx + 1).trim(); // "Hint: ..."
  }

  // Try to match a known pattern
  const matched = ERROR_PATTERNS.find((p) => p.test(mainMessage));

  if (matched) {
    const header = `${red("✗")} ${bold(red(matched.label))}`;
    // Use the embedded hint (more specific, contextual) over the generic
    // pattern-matched hint when available.
    const hintText = embeddedHint ?? matched.hint;
    const body = [
      ` ${mainMessage.length > 200 ? safeTruncate(mainMessage, 200) + "…" : mainMessage}`,
      "",
      ` ${yellow("Hint:")} ${hintText}`,
    ].join("\n");
    return formatBox(header, body);
  }

  // Generic error formatting
  const header = `${red("✗")} ${bold(red("Error"))}`;
  if (embeddedHint) {
    // Error didn't match a known pattern but has an embedded hint — show both.
    const truncated = mainMessage.length > 300 ? safeTruncate(mainMessage, 300) + "…" : mainMessage;
    const body = [
      ` ${truncated}`,
      "",
      ` ${yellow("Hint:")} ${embeddedHint}`,
    ].join("\n");
    return formatBox(header, body);
  }
  const truncated = mainMessage.length > 300 ? safeTruncate(mainMessage, 300) + "…" : mainMessage;
  return formatBox(header, ` ${truncated}`);
}

// ── Welcome Banner ────────────────────────────────────────────────────────────

/** Fallback version when build-info.json is missing (dev builds). */
const DEFAULT_VERSION = "0.1.0";

// ── Build Info ───────────────────────────────────────────────────────────────

/**
 * Build metadata populated by the self-improvement loop before each commit.
 * Loaded from `build-info.json` at the project root. Fields:
 *   - version:    Semantic version (major.minor.patch) — patch is bumped on
 *                 every self-improvement commit
 *   - iteration:  The self-improvement round number
 *   - timestamp:  ISO-8601 timestamp of the build
 *   - commitId:   Short git commit hash (7 chars)
 *
 * When the file is missing or malformed the banner gracefully omits the
 * build-info line and falls back to DEFAULT_VERSION.
 */
interface BuildInfo {
  version?: string;
  iteration?: number;
  timestamp?: string;
  commitId?: string;
}

/**
 * Load build-info.json from the project root (relative to this source file).
 * Returns `null` when the file doesn't exist or can't be parsed — callers
 * should treat a missing BuildInfo as "development build".
 */
function loadBuildInfo(): BuildInfo | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = resolve(dirname(thisFile), "..");
    const raw = readFileSync(resolve(projectRoot, "build-info.json"), "utf-8");
    return JSON.parse(raw) as BuildInfo;
  } catch {
    return null;
  }
}

/** Cached build info — loaded once at module init time. */
const BUILD_INFO: BuildInfo | null = loadBuildInfo();

/**
 * Render the welcome banner shown at REPL startup.
 *
 * Displays the application name, model, working directory,
 * build info (iteration, timestamp, commit), and available REPL commands.
 *
 * @param config - Application configuration
 * @param cwd    - Current working directory (from the context, not process.cwd())
 */
export function renderWelcomeBanner(config: AppConfig, cwd?: string): string {
  const version = BUILD_INFO?.version ?? DEFAULT_VERSION;
  const title = `${bold(cyan("CodingAgent"))} ${dim(`v${version}`)}`;

  // Build info line: "Iteration: 42 | 2026-02-20T20:59:00Z | abc1234"
  let buildInfoLine = "";
  if (BUILD_INFO) {
    const parts: string[] = [];
    if (BUILD_INFO.iteration != null) {
      parts.push(`Iter ${BUILD_INFO.iteration}`);
    }
    if (BUILD_INFO.timestamp) {
      // Show a compact date (YYYY-MM-DD HH:MM) instead of full ISO string
      const d = new Date(BUILD_INFO.timestamp);
      if (!isNaN(d.getTime())) {
        const dateStr = d.toISOString().replace("T", " ").slice(0, 16);
        parts.push(dateStr);
      }
    }
    if (BUILD_INFO.commitId) {
      parts.push(BUILD_INFO.commitId);
    }
    if (parts.length > 0) {
      buildInfoLine = ` ${dim("Build:")}  ${dim(parts.join(" │ "))}`;
    }
  }

  const lines = [
    "",
    ` ${dim("Model:")}  ${white(config.model)}`,
    ` ${dim("CWD:")}    ${white(cwd ?? (() => { try { return process.cwd(); } catch { return "(unknown)"; } })())}`,
    ...(buildInfoLine ? [buildInfoLine] : []),
    "",
    ` ${dim("Commands:")}`,
    `   ${cyan("/help")}     Show all commands & shortcuts`,
    `   ${cyan("/status")}   Session info & token usage`,
    `   ${cyan("/save")}     Save session to disk`,
    `   ${cyan("/resume")}   Resume a previous session`,
    `   ${cyan("/reload")}   Hot restart (reload code)`,
    `   ${cyan("/quit")}     Exit the REPL`,
    "",
    ` ${dim("Press")} ${bold("Ctrl+C")} ${dim("to interrupt, twice to exit.")}`,
    ` ${dim("End a line with")} ${bold("\\")} ${dim("for multiline input.")}`,
    ` ${dim("Type")} ${bold("/")} ${dim("then")} ${bold("Tab")} ${dim("or")} ${bold("→")} ${dim("to accept the autocomplete suggestion.")}`,
    ` ${dim("Sessions auto-save after every turn.")}`,
    "",
  ];

  return formatBox(title, lines.join("\n"), 58);
}

// ── Status Bar ────────────────────────────────────────────────────────────────

/**
 * Render a compact status bar showing token usage, message count,
 * active model, elapsed duration, cumulative API token usage, and
 * estimated cost.
 *
 * Token color thresholds are relative to `compactionThreshold` so users
 * with custom thresholds (e.g., 50K or 500K) get meaningful warnings:
 *   - Green:  below 65% of threshold (plenty of room)
 *   - Yellow: 65%–90% of threshold (approaching compaction)
 *   - Red ⚠:  above 90% of threshold (compaction imminent or overdue)
 * Falls back to the default threshold (160K) when not provided.
 *
 * @param tokens  - Estimated context token count (heuristic-based)
 * @param messages - Number of messages in conversation
 * @param model    - Currently active model name
 * @param durationMs - Elapsed time for the last turn (optional)
 * @param apiUsage - Cumulative API token usage from actual API responses (optional)
 * @param compactionThreshold - Auto-compaction threshold from config (optional)
 * @param estimatedCost - Cumulative estimated cost in USD (optional)
 */
export function renderStatusBar(
  tokens: number,
  messages: number,
  model: string,
  durationMs?: number,
  apiUsage?: { inputTokens: number; outputTokens: number },
  compactionThreshold?: number,
  estimatedCost?: number
): string {
  const parts: string[] = [];

  // Token usage with color coding relative to compaction threshold.
  // Previously hardcoded at 150K/100K, which was misleading for users
  // with custom thresholds — e.g., a user with threshold=50K would see
  // green at 90K (nearly double their threshold, compaction overdue).
  const threshold = compactionThreshold && compactionThreshold > 0
    ? compactionThreshold
    : 160_000; // default from config.ts
  const tokenStr = tokens.toLocaleString();
  if (tokens > threshold * 0.9) {
    parts.push(`${red("⚠")} ${red(tokenStr)} tokens`);
  } else if (tokens > threshold * 0.65) {
    parts.push(`${yellow(tokenStr)} tokens`);
  } else {
    parts.push(`${green(tokenStr)} tokens`);
  }

  // Message count
  parts.push(`${messages} msg${messages !== 1 ? "s" : ""}`);

  // Cumulative API token usage (from actual API responses, not heuristic).
  // Shows total input + output tokens consumed this session so users can
  // track real-time cost without needing `/status`. Only shown when there's
  // actual API usage data (not for the first render before any API calls).
  if (apiUsage && (apiUsage.inputTokens > 0 || apiUsage.outputTokens > 0)) {
    const totalApi = apiUsage.inputTokens + apiUsage.outputTokens;
    parts.push(dim(`${totalApi.toLocaleString()} API tok`));
  }

  // Estimated cumulative cost in USD. Shown inline so users can track spend
  // in real-time after every turn without running `/status`. Only displayed
  // when cost is meaningful (>= $0.001) to avoid noise on the first turn.
  if (estimatedCost != null && estimatedCost >= 0.001) {
    const costStr = estimatedCost < 0.01
      ? estimatedCost.toFixed(4)
      : estimatedCost < 1
        ? estimatedCost.toFixed(3)
        : estimatedCost.toFixed(2);
    parts.push(dim(`~$${costStr}`));
  }

  // Model (abbreviated if too long)
  const shortModel = model.length > 25 ? safeTruncate(model, 22) + "…" : model;
  parts.push(dim(shortModel));

  // Duration
  if (durationMs != null) {
    parts.push(dim(formatDuration(durationMs)));
  }

  return dim("─ ") + parts.join(dim(" │ ")) + dim(" ─");
}

// ── Help Display ──────────────────────────────────────────────────────────────

/** Command definition for the help display. */
interface HelpCommand {
  command: string;
  description: string;
}

/**
 * All available REPL commands — auto-discovered from the command registry.
 *
 * Previously this was a hardcoded static array that had to be manually kept
 * in sync with the `handleCommand()` switch statement in index.ts. Commands
 * added to the switch (like `/cache`) but not to this array would be silently
 * missing from /help, tab-completion, and inline hints.
 *
 * Now commands register themselves via `registerCommand()` in commands.ts,
 * and these functions return them dynamically at call time. This avoids the
 * module-load-order issue where ui.ts is imported (and its module-level code
 * runs) before index.ts has registered its commands.
 */

/**
 * Get all registered REPL commands for help display, suggestions, and hints.
 * Includes both built-in commands and dynamic skill commands.
 * Always returns the latest registrations from the command registry.
 */
function getHelpCommands(): readonly HelpCommand[] {
  const commands = getRegisteredCommands();
  const skills = getRegisteredSkills();
  if (skills.length === 0) return commands;
  return [...commands, ...skills];
}

/**
 * Get only the built-in REPL commands (no skills).
 * Used by `renderHelp()` to display commands and skills in separate sections.
 */
function getBuiltinCommands(): readonly HelpCommand[] {
  return getRegisteredCommands();
}

/**
 * Get only the dynamic skill commands.
 * Used by `renderHelp()` to display skills in a separate section.
 */
function getSkillCommands(): readonly HelpCommand[] {
  return getRegisteredSkills();
}

/**
 * Get all command names (base command + aliases) for tab-completion.
 * Always returns the latest registrations from the command registry.
 */
function getCommandNamesLive(): readonly string[] {
  return getAllCommandNames();
}

/**
 * Backward-compatible re-exports.
 * These are evaluated lazily by the functions that use them — no function
 * in this module accesses them at module load time, so the fact that the
 * registry may be empty at import time is not a problem.
 */
export { getHelpCommands, getCommandNamesLive as getCommandNames };

// ── Frecency Integration ─────────────────────────────────────────────────────

/**
 * Current frecency scores, updated externally by calling `setFrecencyScores()`.
 * Kept here rather than importing from frecency.ts to avoid circular dependencies
 * (ui.ts is imported by many modules).
 */
let currentFrecencyScores: Map<string, number> | undefined;

/**
 * Update the frecency scores used for ranking hints and completions.
 * Called by index.ts after loading or updating frecency data.
 */
export function setFrecencyScores(scores: Map<string, number>): void {
  currentFrecencyScores = scores;
}

// ── Readline Completer ───────────────────────────────────────────────────────

/**
 * Readline completer for slash commands.
 * Uses fast prefix matching only (no Levenshtein) for responsiveness.
 */
export function commandCompleter(line: string): [string[], string] {
  if (!line.startsWith("/")) {
    return [[], line];
  }
  const matches = fastMatch(line, getHelpCommands(), currentFrecencyScores);
  const hits = matches.map((m) => m.entry.command.split(" ")[0]);
  return [hits.length ? hits : [...getCommandNamesLive()], line];
}

// ── Fast Matching Engine ──────────────────────────────────────────────────────

/** A command match with its computed score and frecency boost. */
interface ScoredMatch {
  entry: HelpCommand;
  /** 100+ = prefix, 50 = substring. */
  score: number;
  /** Frecency score (frequency × recency), default 0. */
  frecency: number;
}

/**
 * Fast prefix + substring matcher. No Levenshtein — used on every keystroke.
 * Returns matches sorted by: prefix first → frecency → alphabetical.
 */
function fastMatch(
  query: string,
  commands: readonly HelpCommand[],
  frecencyScores?: Map<string, number>,
): ScoredMatch[] {
  const q = query.toLowerCase().replace(/^\//, "");
  const results: ScoredMatch[] = [];

  for (const entry of commands) {
    const baseName = entry.command.split(" ")[0];
    const c = baseName.toLowerCase().replace(/^\//, "");

    let score: number;
    if (!q) {
      score = 100; // empty query matches everything
    } else if (c.startsWith(q)) {
      score = 100 + q.length; // prefix match
    } else if (c.includes(q)) {
      score = 50; // substring match
    } else {
      continue; // no match
    }

    const frecency = frecencyScores?.get(baseName) ?? 0;
    results.push({ entry, score, frecency });
  }

  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.frecency !== b.frecency) return b.frecency - a.frecency;
    return a.entry.command.localeCompare(b.entry.command);
  });

  return results;
}

/**
 * Returns a Set of skill command base names (e.g. "/commit") for
 * visual distinction in hints and suggestions.
 */
function getSkillNameSet(): Set<string> {
  const skills = getRegisteredSkills();
  return new Set(skills.map((s) => s.command.split(" ")[0]));
}

/**
 * Color a command name: magenta for skills, cyan for built-in commands.
 */
function colorCommand(cmd: string, skillNames: Set<string>): string {
  const base = cmd.split(" ")[0].trimEnd();
  return skillNames.has(base) ? magenta(cmd) : cyan(cmd);
}

/**
 * Render a compact "did you mean" list for unrecognized commands.
 * This is NOT called on every keystroke — only after the user presses Enter.
 * Uses Levenshtein for fuzzy matching since it only runs once.
 */
export function renderCommandSuggestions(partial: string): string {
  // Use a full fuzzy match here — it's a one-shot operation, not per-keystroke.
  const q = partial.toLowerCase().replace(/^\//, "");
  const commands = getHelpCommands();
  const scored: ScoredMatch[] = [];

  for (const entry of commands) {
    const baseName = entry.command.split(" ")[0];
    const c = baseName.toLowerCase().replace(/^\//, "");

    let score: number | null = null;
    if (!q) {
      score = 100;
    } else if (c.startsWith(q)) {
      score = 100 + q.length;
    } else if (c.includes(q)) {
      score = 50;
    } else {
      const dist = levenshteinDistance(q, c);
      if (dist <= 3 && dist < q.length) {
        score = Math.max(1, 25 - dist);
      }
    }

    if (score !== null) {
      scored.push({ entry, score, frecency: currentFrecencyScores?.get(baseName) ?? 0 });
    }
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.frecency !== b.frecency) return b.frecency - a.frecency;
    return a.entry.command.localeCompare(b.entry.command);
  });

  if (scored.length === 0) {
    return `${red("✗")} Unknown command ${bold(partial)}. Type ${cyan("/help")} to see all commands.`;
  }
  const skillNames = getSkillNameSet();
  const lines = scored.slice(0, 8).map(({ entry: { command, description } }) =>
    `  ${colorCommand(command.padEnd(22), skillNames)} ${dim(description)}`
  );
  return `${dim("Did you mean:")}\n${lines.join("\n")}`;
}

/**
 * Levenshtein distance — only used by renderCommandSuggestions (one-shot).
 */
const MAX_LEVENSHTEIN_LEN = 50;

function levenshteinDistance(a: string, b: string): number {
  if (a.length > b.length) [a, b] = [b, a];
  if (a.length > MAX_LEVENSHTEIN_LEN) a = a.slice(0, MAX_LEVENSHTEIN_LEN);
  if (b.length > MAX_LEVENSHTEIN_LEN) b = b.slice(0, MAX_LEVENSHTEIN_LEN);
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

// ── Real-time Inline Command Hints ───────────────────────────────────────────

/**
 * Get matching commands for a partial input string.
 */
export function getMatchingCommands(partial: string): { command: string; description: string; score: number }[] {
  if (!partial.startsWith("/")) return [];
  const matches = fastMatch(partial, getHelpCommands(), currentFrecencyScores);
  return matches.map((r) => ({
    command: r.entry.command,
    description: r.entry.description,
    score: r.score,
  }));
}

/** Maximum number of hint rows to display. */
const MAX_HINT_ROWS = 5;

/**
 * Render inline hint lines for real-time display below the input.
 * Simple dim lines — no box borders, no complex ANSI cursor gymnastics.
 *
 * @returns Object with rendered lines, total page count, and matched items
 */
export function renderInlineHints(
  partial: string,
  page = 0,
): { lines: string[]; totalPages: number; matchedCommands: string[] } {
  const empty = { lines: [], totalPages: 0, matchedCommands: [] };
  if (!partial.startsWith("/")) return empty;

  const lower = partial.toLowerCase();
  const parts = lower.split(/\s+/);
  const baseCmd = parts[0];

  // ── Argument mode: user typed an exact command + space ──
  const commandNames = getCommandNamesLive();
  const exactMatch = commandNames.find((c) => c === baseCmd);
  if (exactMatch && partial.length > exactMatch.length) {
    const provider = getArgumentProvider(baseCmd);
    if (!provider) return empty;
    const argPartial = parts.length > 1 ? parts.slice(1).join(" ") : "";
    const suggestions = provider();
    const filtered = argPartial
      ? suggestions.filter((s) => s.value.toLowerCase().startsWith(argPartial.toLowerCase()))
      : suggestions;
    if (filtered.length === 0) return empty;

    // Format argument suggestions as simple dim lines
    const allLines = filtered.map((s) => {
      const val = cyan(s.value.padEnd(22));
      const desc = s.description ? dim(s.description) : "";
      return `  ${val} ${desc}`;
    });
    const totalPages = Math.ceil(allLines.length / MAX_HINT_ROWS);
    const safePage = totalPages > 0 ? ((page % totalPages) + totalPages) % totalPages : 0;
    const start = safePage * MAX_HINT_ROWS;
    const visible = allLines.slice(start, start + MAX_HINT_ROWS);
    if (totalPages > 1) {
      visible.push(dim(`  ${safePage + 1}/${totalPages} ↑↓`));
    }
    return { lines: visible, totalPages, matchedCommands: filtered.map((s) => s.value) };
  }

  // ── Command mode: prefix + substring match ──
  const matches = fastMatch(partial, getHelpCommands(), currentFrecencyScores);

  // Don't show hints if there's exactly one match and it's already fully typed
  if (matches.length === 1 && matches[0].entry.command.split(" ")[0] === baseCmd) return empty;
  if (matches.length === 0) return empty;

  const skillNames = getSkillNameSet();
  const matchedCommands = matches.map((r) => r.entry.command.split(" ")[0]);

  // Check if both commands and skills are in the results
  const hasCommands = matches.some((r) => !skillNames.has(r.entry.command.split(" ")[0]));
  const hasSkills = matches.some((r) => skillNames.has(r.entry.command.split(" ")[0]));
  const showHeaders = hasCommands && hasSkills;

  // Build formatted lines
  const allLines: string[] = [];

  if (showHeaders) {
    const cmdEntries = matches.filter((r) => !skillNames.has(r.entry.command.split(" ")[0]));
    const skillEntries = matches.filter((r) => skillNames.has(r.entry.command.split(" ")[0]));

    if (cmdEntries.length > 0) {
      allLines.push(dim("  Commands"));
      for (const r of cmdEntries) {
        const name = r.entry.command.split(" ")[0];
        allLines.push(`  ${cyan(name.padEnd(22))} ${dim(r.entry.description)}`);
      }
    }
    if (skillEntries.length > 0) {
      allLines.push(dim("  Skills"));
      for (const r of skillEntries) {
        const name = r.entry.command.split(" ")[0];
        allLines.push(`  ${magenta(name.padEnd(22))} ${dim(r.entry.description)}`);
      }
    }
  } else {
    for (const r of matches) {
      const name = r.entry.command.split(" ")[0];
      const colorFn = skillNames.has(name) ? magenta : cyan;
      allLines.push(`  ${colorFn(name.padEnd(22))} ${dim(r.entry.description)}`);
    }
  }

  // Paginate
  const totalPages = Math.ceil(allLines.length / MAX_HINT_ROWS);
  const safePage = totalPages > 0 ? ((page % totalPages) + totalPages) % totalPages : 0;
  const start = safePage * MAX_HINT_ROWS;
  const visible = allLines.slice(start, start + MAX_HINT_ROWS);
  if (totalPages > 1) {
    visible.push(dim(`  ${safePage + 1}/${totalPages} ↑↓`));
  }

  return { lines: visible, totalPages, matchedCommands };
}

/**
 * A Transform stream that sits between process.stdin and readline.
 * Intercepts ↑/↓ arrow keys for pagination when hints are visible.
 */
class HintAwareInputStream extends Transform {
  /** When > 1, ↑/↓ arrow keys are swallowed for page navigation. */
  totalPages = 0;

  /**
   * Current ghost text (the untyped completion suffix). Updated by
   * InlineHintManager on every keystroke. When non-empty, Tab and
   * Right-arrow (at end of line) accept it instead of their default action.
   */
  currentGhostText = "";

  /** Whether the cursor is at the end of the readline input. */
  cursorAtEnd = true;

  onUp: () => void = () => {};
  onDown: () => void = () => {};
  /** Called when Tab/Right-arrow accepts ghost text. */
  onAcceptGhost: () => void = () => {};

  readonly isTTY: boolean = !!(process.stdin as any).isTTY;

  setRawMode(mode: boolean): this {
    if (typeof (process.stdin as any).setRawMode === "function") {
      (process.stdin as any).setRawMode(mode);
    }
    return this;
  }

  constructor() {
    super();
  }

  _transform(chunk: Buffer, _encoding: string, callback: () => void): void {
    const data = chunk.toString("binary");

    if (this.totalPages > 1) {
      if (data === "\x1b[A") { this.onUp(); callback(); return; }
      if (data === "\x1b[B") { this.onDown(); callback(); return; }
    }

    // Tab or Right-arrow accepts ghost text when available
    if (this.currentGhostText) {
      const isTab = data === "\t";
      const isRight = data === "\x1b[C" && this.cursorAtEnd;
      if (isTab || isRight) {
        // Push the ghost text as if the user typed it
        this.push(Buffer.from(this.currentGhostText, "utf-8"));
        this.currentGhostText = "";
        this.onAcceptGhost();
        callback();
        return;
      }
    }

    this.push(chunk);
    callback();
  }
}

/**
 * Get the ghost text suffix for the best prefix match.
 * Returns the untyped remainder or empty string.
 */
export function getGhostText(
  partial: string,
  frecencyScores?: Map<string, number>,
): string {
  if (!partial.startsWith("/")) return "";

  const parts = partial.split(/\s+/);
  const baseCmd = parts[0].toLowerCase();

  // Argument ghost text: after a complete command + space
  if (parts.length > 1) {
    const provider = getArgumentProvider(baseCmd);
    if (!provider) return "";
    const argPartial = parts.slice(1).join(" ");
    const suggestions = provider();
    const match = suggestions.find((s) =>
      s.value.toLowerCase().startsWith(argPartial.toLowerCase()),
    );
    if (match && match.value.toLowerCase() !== argPartial.toLowerCase()) {
      return match.value.slice(argPartial.length);
    }
    return "";
  }

  // Command ghost text: best prefix match
  const matches = fastMatch(partial, getHelpCommands(), frecencyScores);
  if (matches.length === 0 || matches[0].score < 100) return "";
  const baseName = matches[0].entry.command.split(" ")[0];
  if (baseName === partial.toLowerCase()) return "";
  return baseName.slice(partial.length);
}

/**
 * Manages real-time inline command hints for a readline interface.
 *
 * Strategy: "input locked at bottom".
 *
 * On the very first hint render we write MAX_RESERVE newlines to create
 * a fixed-size hint region below the prompt, then move back up. This
 * region is NEVER resized — subsequent renders simply overwrite it using
 * cursor save/restore and a single atomic write(). When hints disappear,
 * the region is blanked but remains allocated; when all input is cleared,
 * we collapse it.
 *
 * Because the region size is constant, readline's prompt position never
 * drifts — the terminal only scrolled once (during the initial `\n`
 * burst), and after that all rendering is purely positional.
 *
 * All ANSI output is batched into a single `process.stdout.write()` call
 * per update to eliminate flicker, bracketed by cursor hide/show.
 */
export class InlineHintManager {
  private rl: ReadlineInterface | null = null;
  /** Whether we have allocated the hint region below the prompt. */
  private regionAllocated = false;
  private keypressHandler: (str: string | undefined, key: ReadlineKey) => void;
  private attached = false;
  private currentPage = 0;
  private totalPages = 0;
  private lastLine = "";
  private inputStream: HintAwareInputStream;
  /** Length of the last ghost text we rendered (to erase on next update). */
  private lastGhostLen = 0;

  /**
   * Fixed number of rows reserved below the prompt for hints.
   * MAX_HINT_ROWS (5) + 1 for the optional pagination indicator.
   */
  private static readonly MAX_RESERVE = MAX_HINT_ROWS + 1;

  constructor() {
    this.inputStream = new HintAwareInputStream();

    this.inputStream.onUp = () => {
      if (this.totalPages > 1) {
        this.currentPage = (this.currentPage - 1 + this.totalPages) % this.totalPages;
        this.update();
      }
    };
    this.inputStream.onDown = () => {
      if (this.totalPages > 1) {
        this.currentPage = (this.currentPage + 1) % this.totalPages;
        this.update();
      }
    };
    this.inputStream.onAcceptGhost = () => {
      // Ghost was accepted — clear ghost state and re-render hints
      this.lastGhostLen = 0;
      setImmediate(() => this.update());
    };

    this.keypressHandler = () => {
      setImmediate(() => this.update());
    };
  }

  createInputStream(): Transform {
    process.stdin.pipe(this.inputStream);
    return this.inputStream;
  }

  attachReadline(rl: ReadlineInterface): void {
    this.rl = rl;
    this.attach();
  }

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    emitKeypressEvents(process.stdin as NodeJS.ReadableStream);
    process.stdin.on("keypress", this.keypressHandler);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.clearHints();
    process.stdin.removeListener("keypress", this.keypressHandler);
    process.stdin.unpipe(this.inputStream);
  }

  private getCurrentLine(): string {
    if (!this.rl) return "";
    return this.rl.line;
  }

  /** Get the cursor column position on the prompt line. */
  private getCursorCol(): number {
    return (this.rl as any)?.getCursorPos?.()?.cols ?? 0;
  }

  /**
   * Erase hint content and deallocate the region.
   * Called from index.ts when the user submits a command or on Ctrl+C.
   * The next hint render will re-allocate space below the new prompt.
   */
  clearHints(): void {
    // Clear ghost text from the input stream
    this.inputStream.currentGhostText = "";
    this.lastGhostLen = 0;
    if (!this.regionAllocated) return;
    this.blankRegion();
    this.regionAllocated = false;
  }

  /**
   * Erase hint content but keep the region allocated.
   * Used internally when the user deletes `/` mid-typing — the prompt
   * hasn't moved so the reserved space is still valid.
   *
   * Uses explicit relative cursor movement (not \x1b[s/u save/restore)
   * to avoid global saved-position state bugs.
   */
  private blankRegion(): void {
    if (!this.regionAllocated) return;
    const out = process.stdout;
    if (!out.isTTY) return;

    const col = this.getCursorCol();

    // Hide cursor, move down 1 into hint region, clear to end of screen,
    // move back up 1, restore column, show cursor.
    out.write(
      "\x1b[?25l" +
      "\x1b[1B" +     // down 1 row
      "\x1b[0J" +     // clear to end of screen
      "\x1b[1A" +     // up 1 row (back to prompt)
      `\x1b[${col + 1}G` +  // absolute column (1-based)
      "\x1b[?25h"
    );
  }

  /**
   * Render/update hints below the current input line.
   * Called on every keypress via setImmediate.
   *
   * Uses explicit relative cursor movement instead of \x1b[s/u to avoid
   * cursor position bugs when readline redraws the prompt.
   */
  private update(): void {
    const out = process.stdout;
    if (!out.isTTY || !this.rl) return;

    const line = this.getCurrentLine();
    const col = this.getCursorCol();
    const cursorPos = (this.rl as any).cursor ?? line.length;

    // Update cursor-at-end state so the input stream knows when to
    // accept Right-arrow for ghost text vs. normal cursor movement.
    this.inputStream.cursorAtEnd = cursorPos >= line.length;

    // Reset page when the input text changes
    if (line !== this.lastLine) {
      this.currentPage = 0;
      this.lastLine = line;
    }

    // ── Ghost text ──
    // Compute ghost text (dim completion suffix shown after cursor).
    const ghost = line.startsWith("/") && cursorPos >= line.length
      ? getGhostText(line, currentFrecencyScores)
      : "";
    this.inputStream.currentGhostText = ghost;

    // Erase previous ghost text if it changed or disappeared
    if (this.lastGhostLen > 0) {
      // Overwrite the old ghost region with spaces, then move cursor back
      out.write(
        "\x1b[?25l" +
        `\x1b[${col + 1}G` +        // position at cursor column
        " ".repeat(this.lastGhostLen) +  // overwrite ghost with spaces
        `\x1b[${col + 1}G` +        // move back
        "\x1b[?25h"
      );
      this.lastGhostLen = 0;
    }

    // Render new ghost text (dim, after cursor)
    if (ghost) {
      this.lastGhostLen = ghost.length;
      out.write(
        "\x1b[?25l" +
        `\x1b[${col + 1}G` +      // position at cursor column
        dim(ghost) +               // dim ghost text
        `\x1b[${col + 1}G` +      // move cursor back
        "\x1b[?25h"
      );
    }

    if (!line.startsWith("/")) {
      this.blankRegion();
      this.totalPages = 0;
      this.inputStream.totalPages = 0;
      return;
    }

    const result = renderInlineHints(line, this.currentPage);
    this.totalPages = result.totalPages;
    this.inputStream.totalPages = result.totalPages;

    if (result.lines.length === 0) {
      this.blankRegion();
      return;
    }

    const reserve = InlineHintManager.MAX_RESERVE;

    // Allocate the hint region once. Write `reserve` newlines to scroll
    // the terminal and create space, then move back up. This is the ONLY
    // time we write \n. All subsequent renders reuse this space.
    if (!this.regionAllocated) {
      out.write("\n".repeat(reserve));
      moveCursor(out, 0, -reserve);
      this.regionAllocated = true;
    }

    // Remember cursor column so we can return to it.
    const hintLines = result.lines;
    const termWidth = out.columns || 80;

    // Build the entire frame as one string for atomic write.
    // Move down into the hint region, clear it, write hints,
    // then move back up to the prompt and restore the column.
    let buf = "\x1b[?25l";   // hide cursor
    buf += "\x1b[1B";         // move down 1 row (into hint region)
    buf += "\x1b[0J";         // clear from cursor to end of screen

    // Write each hint line
    for (let i = 0; i < hintLines.length; i++) {
      buf += "\r";            // carriage return (column 0)
      buf += hintLines[i].slice(0, termWidth);  // truncate to avoid wrapping
      if (i < hintLines.length - 1) {
        buf += "\n";          // newline between hint lines (within reserved area)
      }
    }

    // Move back to prompt line:
    // We're on row (1 + hintLines.length - 1) = hintLines.length below prompt.
    // Move up that many rows + restore column.
    buf += `\x1b[${hintLines.length}A`;       // up N rows to prompt
    buf += `\x1b[${col + 1}G`;                // absolute column (1-based)
    buf += "\x1b[?25h";                        // show cursor

    out.write(buf);
  }
}

/** Keyboard shortcut definitions for help display. */
const HELP_SHORTCUTS: readonly HelpCommand[] = [
  { command: "Tab / →",     description: "Accept autocomplete suggestion" },
  { command: "Ctrl+C",       description: "Interrupt current operation" },
  { command: "Ctrl+C ×2",    description: "Force quit" },
  { command: "line \\",      description: "Continue input on next line" },
] as const;

/**
 * Render the full help display with all REPL commands and keyboard shortcuts.
 */
export function renderHelp(): string {
  // Find the longest command name for alignment
  const commands = getBuiltinCommands();
  const skills = getSkillCommands();
  const allEntries = [...commands, ...skills, ...HELP_SHORTCUTS];
  const maxLen = Math.max(...allEntries.map((c) => c.command.length));

  const commandLines = commands.map(({ command, description }) => {
    const padded = command.padEnd(maxLen + 2);
    return ` ${cyan(padded)} ${description}`;
  });

  const shortcutLines = HELP_SHORTCUTS.map(({ command, description }) => {
    const padded = command.padEnd(maxLen + 2);
    return ` ${yellow(padded)} ${description}`;
  });

  const sections = [
    "",
    ` ${bold("Commands")}`,
    ...commandLines,
  ];

  if (skills.length > 0) {
    const skillLines = skills.map(({ command, description }) => {
      const padded = command.padEnd(maxLen + 2);
      return ` ${magenta(padded)} ${description}`;
    });
    sections.push("", ` ${bold("Skills")}`, ...skillLines);
  }

  sections.push(
    "",
    ` ${bold("Shortcuts")}`,
    ...shortcutLines,
    "",
    ` ${dim("Enter any text to chat with the assistant.")}`,
    ` ${dim("All tool calls execute automatically.")}`,
    "",
  );

  const title = `${bold(cyan("Help"))}`;
  return formatBox(title, sections.join("\n"), 56);
}

// ── Centralized Output Manager ──────────────────────────────────────────────

/**
 * Readline-safe output manager.
 *
 * All terminal output that may fire while the REPL prompt is active should
 * go through this singleton. It handles the coordination between stdout
 * writes and readline's internal cursor state (`prevRows`, `clearScreenDown`)
 * so that messages appear cleanly above the prompt instead of being
 * overwritten by readline's next `_refreshLine` call.
 *
 * **Why this is needed:**
 *
 * Node's `readline` module tracks the number of display rows the prompt
 * occupies in `prevRows`. When `_refreshLine()` fires (on every prompt
 * redraw), it moves the cursor UP by `prevRows`, then calls
 * `clearScreenDown` to erase everything below — which wipes any text that
 * was printed between the old prompt and the new prompt. This is invisible
 * for synchronous command output (readline is paused during `for await`
 * processing), but destroys messages printed by asynchronous callbacks
 * (MCP server loading, background agent completion, MCP server crashes,
 * config hot-reload notifications, etc.).
 *
 * **Architecture:**
 *
 * - When readline is NOT attached (non-interactive / `-p` / piped stdin),
 *   all methods delegate directly to `console.log` / `process.stdout.write`.
 * - When readline IS attached (REPL mode), output methods:
 *   1. Clear inline hints (if visible)
 *   2. Clear the current prompt line (`\r\x1b[K`)
 *   3. Print the message
 *   4. Reset `prevRows` to 0 so readline doesn't cursor-up into the message
 *   5. Re-draw the prompt below the message
 *
 * Modules like `loop.ts`, `config.ts`, `mcp-client.ts`, `session.ts`, etc.
 * call `printWarning()` / `printInfo()` which delegate here — they get
 * readline-safe output automatically without knowing readline exists.
 *
 * Thread safety: Node.js is single-threaded, so the clear→print→re-prompt
 * sequence is atomic. No interleaving between concurrent async callbacks.
 */
export class OutputManager {
  private rl: ReadlineInterface | null = null;
  private hintManager: InlineHintManager | null = null;

  /**
   * Attach the readline interface and hint manager. Called once from
   * `index.ts` after the REPL's `rl` and `InlineHintManager` are created.
   * After this call, all output goes through the readline-safe path.
   */
  setReadline(rl: ReadlineInterface, hintManager: InlineHintManager): void {
    this.rl = rl;
    this.hintManager = hintManager;
  }

  /**
   * Detach readline. Called when the REPL shuts down (e.g., `/reload`,
   * process exit) so the OutputManager stops manipulating a closed
   * readline interface.
   */
  detachReadline(): void {
    this.rl = null;
    this.hintManager = null;
  }

  /** Whether readline is attached (REPL mode). */
  get isInteractive(): boolean {
    return this.rl !== null;
  }

  /**
   * Print a complete line of text. Readline-safe: clears the prompt,
   * prints the line, then re-draws the prompt below it.
   *
   * Use for discrete messages (info, warnings, command output).
   * Do NOT use for streaming text — use `write()` instead.
   */
  log(text: string): void {
    if (!this.rl || !process.stdout.isTTY) {
      console.log(text);
      return;
    }
    this.hintManager?.clearHints();
    // Move to column 0 and clear the current prompt line
    process.stdout.write("\r\x1b[K");
    console.log(text);
    // Reset readline's row tracker so _refreshLine doesn't cursor-up
    // into the message we just printed and clearScreenDown it away.
    // This accesses a Node.js internal (`prevRows` is not part of the
    // public readline API), but it's the only way to prevent readline
    // from erasing our output. The alternative is reimplementing
    // readline's prompt rendering from scratch.
    if ("prevRows" in this.rl) (this.rl as any).prevRows = 0;
    this.rl.prompt();
  }

  /**
   * Write raw text to stdout without a trailing newline. Readline-safe
   * but does NOT re-draw the prompt — used for streaming assistant text
   * where chunks arrive continuously and a prompt after each chunk would
   * be wrong.
   */
  write(data: string): void {
    process.stdout.write(data);
  }

  /** Print an info message with a cyan ℹ icon. */
  info(message: string): void {
    this.log(`${cyan("ℹ")} ${message}`);
  }

  /** Print a warning message with a yellow ⚠ icon. */
  warn(message: string): void {
    this.log(`${yellow("⚠")} ${message}`);
  }

  /** Print a success message with a green ✓ icon. */
  success(label: string, detail?: string): void {
    const msg = detail
      ? `${green("✓")} ${bold(label)} ${dim(detail)}`
      : `${green("✓")} ${bold(label)}`;
    this.log(msg);
  }
}

/**
 * Singleton output manager. All terminal output should go through this
 * instance (either directly or via the `printInfo`/`printWarning`/
 * `printSuccess` convenience wrappers).
 */
export const output = new OutputManager();

// ── Convenience Output Helpers ────────────────────────────────────────────────

/**
 * Print a success message with a green checkmark.
 * Delegates to the OutputManager for readline-safe output.
 * @example printSuccess("File written", "src/app.ts")
 */
export function printSuccess(label: string, detail?: string): void {
  output.success(label, detail);
}

/**
 * Print a warning message with a yellow icon.
 * Delegates to the OutputManager for readline-safe output.
 */
export function printWarning(message: string): void {
  output.warn(message);
}

/**
 * Print an info message with a cyan icon.
 * Delegates to the OutputManager for readline-safe output.
 */
export function printInfo(message: string): void {
  output.info(message);
}

/**
 * Format a tool invocation header shown when a tool starts executing.
 *
 * Prioritizes the most informative parameters so users immediately see
 * *what* a tool is doing, regardless of JSON iteration order (which is
 * insertion-order and may vary between API responses).
 *
 * @example `"⚡ Bash command=\"ls -la\""`
 * @example `"⚡ Grep pattern=\"TODO\" path=\"src/\""`
 */

/** Parameters shown first for each tool, in priority order. */
const TOOL_PARAM_PRIORITY: Record<string, string[]> = {
  Read:      ["file_path", "offset", "limit"],
  Write:     ["file_path"],
  Edit:      ["file_path", "old_string"],
  Glob:      ["pattern", "path"],
  Grep:      ["pattern", "path", "output_mode"],
  Bash:      ["command"],
  Task:      ["description", "prompt"],
  WebFetch:  ["url"],
  WebSearch: ["query"],
};

/**
 * Tool+parameter-specific truncation lengths. The default is 60 chars, but
 * some parameters are the *only* meaningful identifier for the tool call and
 * deserve more context:
 *   - Bash `command`: Often 80–120 chars (pipelines, paths with args). At 60
 *     chars, the user loses the second half of most commands — the part that
 *     typically distinguishes one Bash call from another (e.g., same `npm run`
 *     prefix, different script targets). 120 chars shows ~85% of typical
 *     commands while still fitting in a terminal.
 *   - WebFetch `url`: URLs with query strings or long paths are commonly
 *     80–100+ chars; truncating at 60 hides the path/query which is usually
 *     the distinguishing part.
 */
const TOOL_PARAM_TRUNCATE_LEN: Record<string, Record<string, number>> = {
  Bash: { command: 120 },
  WebFetch: { url: 100 },
};

export function formatToolUse(toolName: string, input: Record<string, unknown>): string {
  const icon = magenta("⚡");
  const name = bold(toolName);

  // Guard against null/undefined input — `Object.keys(null)` throws TypeError.
  // While the Anthropic SDK's `safeToolInput()` in loop.ts normalizes tool
  // inputs, `formatToolUse` is a public export that could be called with
  // malformed data from restored sessions, corrupt API responses, or
  // test code. Degrade to showing just the tool name rather than crashing.
  if (input == null || typeof input !== "object") {
    return `${icon} ${name}`;
  }

  // Build a compact preview of key input parameters, showing the most
  // informative ones first. Without priority ordering, the first 2 keys
  // in JSON iteration order might be obscure options (e.g., `-i`, `-n`)
  // while the critical `pattern` key is hidden.
  const priority = TOOL_PARAM_PRIORITY[toolName] ?? [];
  const sortedKeys = [
    ...priority.filter((k) => k in input && input[k] != null),
    ...Object.keys(input).filter((k) => !priority.includes(k) && input[k] != null),
  ];

  const previewParts: string[] = [];
  for (const key of sortedKeys) {
    const value = input[key];
    if (value == null) continue;
    let strVal: string;
    if (typeof value === "string") {
      strVal = value;
    } else {
      // Guard against non-serializable values (circular references, BigInt,
      // etc.) — these can appear in tool inputs from restored sessions with
      // corrupt data or unexpected API responses. A crash in formatToolUse
      // would prevent the tool invocation header from rendering, leaving the
      // user with no feedback about what tool is executing.
      try {
        strVal = JSON.stringify(value);
      } catch {
        strVal = "(…)";
      }
    }
    // Collapse newlines and carriage returns into visible escape sequences
    // so the tool invocation header stays on a single terminal line.
    // Without this, multi-line values (common in Edit's old_string, Bash's
    // command with heredocs/pipelines, and Grep's multiline patterns) break
    // the header across multiple lines — the first line shows the tool name
    // and param prefix, then the value's content bleeds into subsequent lines
    // with no visual association to the header. Replacing \r\n/\n/\r with
    // literal `\n`/`\r` keeps the value visually compact while preserving
    // the semantic content. Tabs are similarly collapsed to `\t` to prevent
    // large horizontal jumps that misalign the preview.
    strVal = strVal.replace(/\r\n/g, "\\n").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

    // Show truncated value for the most important params.
    // Use tool+parameter-specific lengths when available (e.g., Bash commands
    // get 120 chars vs the default 60) so the most informative parameters
    // retain enough context to be useful at a glance.
    const maxLen = TOOL_PARAM_TRUNCATE_LEN[toolName]?.[key] ?? 60;
    const truncated = strVal.length > maxLen ? safeTruncate(strVal, maxLen - 3) + "…" : strVal;
    previewParts.push(`${dim(key)}=${dim(`"${truncated}"`)}`);
    // Only show first 2 params to keep it compact
    if (previewParts.length >= 2) break;
  }

  const preview = previewParts.length > 0 ? ` ${previewParts.join(" ")}` : "";
  return `${icon} ${name}${preview}`;
}
