import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

/**
 * Debug logger for CodingAgent.
 *
 * When debug mode is enabled (CODINGAGENT_DEBUG=1, or /debug toggle in REPL),
 * all LLM interactions are logged to individual timestamped JSON files inside
 * a session-specific debug folder:
 *
 *   ~/.codingagent/sessions/<session-id>/debug/
 *     ├── 2026-02-25T02-21-27-218Z_debug_session_start.json
 *     ├── 2026-02-25T02-21-28-100Z_api_request.json
 *     ├── 2026-02-25T02-21-29-500Z_api_response.json
 *     ├── 2026-02-25T02-21-30-200Z_tool_execution.json
 *     └── ...
 *
 * Each log entry is a separate file, named with an ISO timestamp and event
 * type for natural chronological ordering via filesystem sort. Files contain
 * pretty-printed JSON for easy reading and `jq` processing.
 *
 * Placing debug logs inside the session folder keeps related data together:
 * session JSON + debug traces live side-by-side, making it easy to correlate
 * debug output with the conversation that produced it.
 *
 * The logger is intentionally fire-and-forget: write failures are silently
 * ignored so debug logging never breaks the main application flow.
 */

let debugEnabled = false;
/** Directory where debug log files are written for the current session. */
let debugLogDir: string | null = null;
/** Session ID associated with the current debug directory. */
let debugSessionId: string | null = null;
/** Monotonic counter to guarantee unique filenames within the same millisecond. */
let debugFileCounter = 0;

/**
 * Check if debug mode is currently enabled.
 */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Enable debug mode for a specific session. Creates the debug directory
 * inside the session folder and writes an initial session_start entry.
 * Returns the path to the debug log directory.
 *
 * @param sessionId - The session ID to associate debug logs with. If
 *   omitted, a standalone debug directory is created under the sessions
 *   root (for cases where no session is active yet, e.g., startup debug
 *   before the session ID is generated).
 */
export function enableDebug(sessionId?: string): string {
  debugEnabled = true;
  // Re-initialize the debug directory if the session ID changed (e.g.,
  // /clear generates a new session ID, or /resume loads a different one).
  if (debugLogDir && sessionId && sessionId !== debugSessionId) {
    debugLogDir = null;
  }
  if (!debugLogDir) {
    debugLogDir = initDebugDir(sessionId);
    debugSessionId = sessionId ?? null;
    // Write a session start marker
    writeEntry({
      type: "debug_session_start",
      sessionId: sessionId ?? "(no session)",
      pid: process.pid,
      platform: process.platform,
      nodeVersion: process.version,
    });
  }
  return debugLogDir;
}

/**
 * Disable debug mode. The log files are kept on disk for review.
 */
export function disableDebug(): void {
  debugEnabled = false;
}

/**
 * Toggle debug mode. Returns the new state.
 *
 * @param sessionId - The current session ID (needed when enabling).
 */
export function toggleDebug(sessionId?: string): { enabled: boolean; logPath: string } {
  if (debugEnabled) {
    disableDebug();
    return { enabled: false, logPath: debugLogDir ?? "" };
  } else {
    const dir = enableDebug(sessionId);
    return { enabled: true, logPath: dir };
  }
}

/**
 * Get the current debug log directory (null if debug was never enabled).
 */
export function getDebugLogPath(): string | null {
  return debugLogDir;
}

/**
 * Update the session ID for debug logging. Call this when the session ID
 * changes (e.g., after /clear or /resume) so subsequent debug files are
 * written to the new session's folder.
 *
 * If debug mode is currently enabled, the debug directory is re-initialized
 * for the new session. If debug is off, the session ID is stored for when
 * debug is next enabled.
 */
export function setDebugSessionId(sessionId: string): void {
  if (debugEnabled && sessionId !== debugSessionId) {
    // Re-initialize for the new session
    debugLogDir = initDebugDir(sessionId);
    debugSessionId = sessionId;
    writeEntry({
      type: "debug_session_start",
      note: "Session changed — debug directory re-initialized",
      sessionId,
      pid: process.pid,
    });
  } else {
    debugSessionId = sessionId;
  }
}

// ── Internal helpers ──

/**
 * Resolve the sessions root directory. Mirrors the logic in session.ts
 * to keep debug logs co-located with session data.
 */
function getSessionsDir(): string {
  try {
    return join(homedir(), ".codingagent", "sessions");
  } catch {
    return join(tmpdir(), ".codingagent", "sessions");
  }
}

/**
 * Create the debug directory for a session and return its path.
 *
 * Directory structure:
 *   ~/.codingagent/sessions/<session-id>/debug/
 *
 * When no sessionId is provided (startup before session creation),
 * uses a standalone directory:
 *   ~/.codingagent/sessions/_debug-<timestamp>/debug/
 */
function initDebugDir(sessionId?: string): string {
  const sessionsDir = getSessionsDir();
  try {
    const folderName = sessionId ?? `_debug-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const debugDir = join(sessionsDir, folderName, "debug");
    mkdirSync(debugDir, { recursive: true });
    return debugDir;
  } catch {
    // Fallback to CWD if the sessions directory is not writable
    const fallback = join(process.cwd(), `codingagent-debug-${Date.now()}`);
    try {
      mkdirSync(fallback, { recursive: true });
    } catch { /* truly cannot write — debug will be silent */ }
    return fallback;
  }
}

/**
 * Generate a unique, chronologically-sortable filename for a debug entry.
 *
 * Format: <ISO-timestamp>_<seq>_<type>.json
 *   e.g.: 2026-02-25T02-21-27-218Z_001_api_request.json
 *
 * The sequence counter ensures uniqueness within the same millisecond
 * (e.g., multiple tool executions completing in rapid succession).
 * The timestamp prefix ensures `ls` / `dir` sorts files chronologically.
 */
function debugFileName(eventType: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const seq = String(++debugFileCounter).padStart(4, "0");
  // Sanitize event type for filesystem safety (remove slashes, etc.)
  const safeType = eventType.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${ts}_${seq}_${safeType}.json`;
}

/**
 * Write a debug entry to its own timestamped JSON file. Fire-and-forget.
 */
function writeEntry(entry: Record<string, unknown>): void {
  if (!debugEnabled || !debugLogDir) return;
  try {
    const fullEntry = {
      ...entry,
      _ts: new Date().toISOString(),
    };
    const fileName = debugFileName(String(entry.type ?? "unknown"));
    const filePath = join(debugLogDir, fileName);
    writeFileSync(filePath, JSON.stringify(fullEntry, null, 2) + "\n", "utf-8");
  } catch {
    // Silent — debug logging must never break the application
  }
}

// ── Public logging functions ──

/**
 * Log the API request parameters sent to the Anthropic API.
 */
export function debugLogApiRequest(params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: unknown[];
  tools?: unknown[];
  callSite: string;
}): void {
  if (!debugEnabled) return;
  writeEntry({
    type: "api_request",
    callSite: params.callSite,
    model: params.model,
    max_tokens: params.max_tokens,
    systemPromptLength: params.system.length,
    systemPrompt: params.system,
    messageCount: params.messages.length,
    messages: params.messages,
    toolCount: params.tools?.length ?? 0,
    tools: params.tools,
  });
}

/**
 * Log the raw API response from the Anthropic API.
 */
export function debugLogApiResponse(data: {
  callSite: string;
  model: string;
  stopReason: string | null;
  usage: { input_tokens: number; output_tokens: number } | undefined;
  content: unknown[];
  durationMs: number;
}): void {
  if (!debugEnabled) return;
  writeEntry({
    type: "api_response",
    callSite: data.callSite,
    model: data.model,
    stopReason: data.stopReason,
    usage: data.usage,
    contentBlockCount: data.content.length,
    content: data.content,
    durationMs: data.durationMs,
  });
}

/**
 * Log a streaming text delta from the API.
 * Only logs when debug is enabled. These can be very frequent,
 * so they are batched — the full text is logged in debugLogApiResponse.
 */
export function debugLogStreamDelta(text: string): void {
  if (!debugEnabled) return;
  // Don't log individual deltas — they're too noisy.
  // The full response text is captured in debugLogApiResponse.
}

/**
 * Log tool execution details.
 */
export function debugLogToolExecution(data: {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  result?: { content: string; is_error?: boolean };
  durationMs?: number;
}): void {
  if (!debugEnabled) return;
  writeEntry({
    type: "tool_execution",
    toolName: data.toolName,
    toolId: data.toolId,
    input: data.input,
    resultLength: data.result?.content.length,
    resultPreview: data.result?.content.slice(0, 2000),
    isError: data.result?.is_error ?? false,
    durationMs: data.durationMs,
  });
}

/**
 * Log compaction API calls (summarization).
 */
export function debugLogCompaction(data: {
  phase: "request" | "response";
  model?: string;
  messageCount?: number;
  messages?: unknown[];
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  durationMs?: number;
}): void {
  if (!debugEnabled) return;
  writeEntry({
    type: "compaction",
    ...data,
  });
}

/**
 * Log eval judge API calls.
 */
export function debugLogEval(data: {
  phase: "request" | "response";
  judgeName?: string;
  round?: number;
  model?: string;
  prompt?: string;
  verdict?: { isComplete: boolean; reasoning: string };
  durationMs?: number;
}): void {
  if (!debugEnabled) return;
  writeEntry({
    type: "eval",
    ...data,
  });
}

/**
 * Log an arbitrary debug event.
 */
export function debugLog(eventType: string, data: Record<string, unknown>): void {
  if (!debugEnabled) return;
  writeEntry({
    type: eventType,
    ...data,
  });
}
