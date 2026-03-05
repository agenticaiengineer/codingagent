import { spawn } from "child_process";
import { statSync } from "fs";
import type { Tool, ToolInput, ToolContext, ToolResult } from "../core/types.js";
import { requireString, optionalInteger, ToolInputError, hasErrnoCode, safeTruncate } from "./validate.js";
import { onConfigReset } from "../config/config.js";

/**
 * Detect the platform shell and return [executable, args-builder].
 *
 * Previously the Bash tool hardcoded `spawn("bash", ["-c", command])`, which:
 *   - On Windows without WSL: fails with ENOENT (no bash.exe in PATH)
 *   - On Windows with WSL: routes through WSL's bash, running commands in a
 *     Linux environment where Windows Git credentials, PATH entries, and native
 *     tools are unavailable. Paths appear as `/mnt/c/...` instead of `C:\...`.
 *   - On macOS/Linux: works fine
 *
 * The cross-platform approach:
 *   - **Windows**: Use `cmd.exe /s /c "command"` (native Windows shell).
 *     `/s` strips outer quotes so cmd.exe passes the raw command string.
 *     This uses the user's actual Windows PATH, credential managers, etc.
 *   - **macOS/Linux**: Use `bash -c "command"` (POSIX default).
 *
 * Users who explicitly prefer WSL on Windows can set `CODINGAGENT_SHELL=bash`
 * to override the auto-detection and force bash (which will route through WSL
 * if bash.exe is the WSL shim). Similarly, any custom shell can be forced
 * via `CODINGAGENT_SHELL=/path/to/shell`.
 */
interface ShellConfig {
  /** The shell executable to spawn (e.g., "bash", "cmd.exe", "powershell.exe") */
  exe: string;
  /** Build the argument list for spawning shell -c "command" */
  buildArgs: (command: string) => string[];
  /** Whether this is a Windows cmd.exe-style shell (affects error messages) */
  isCmd: boolean;
}

let cachedShellConfig: ShellConfig | null = null;

function getShellConfig(): ShellConfig {
  if (cachedShellConfig) return cachedShellConfig;

  // Allow explicit override via env var for advanced users
  const envShell = process.env.CODINGAGENT_SHELL?.trim();

  if (envShell) {
    // PowerShell detection: support both "powershell" and "pwsh" (cross-platform PS)
    const isPowerShell = /powershell|pwsh/i.test(envShell);
    cachedShellConfig = {
      exe: envShell,
      buildArgs: isPowerShell
        ? (cmd) => ["-NoProfile", "-Command", cmd]
        : (cmd) => ["-c", cmd],
      isCmd: false,
    };
  } else if (process.platform === "win32") {
    // Use native cmd.exe on Windows for proper PATH, credentials, and tool access
    cachedShellConfig = {
      exe: process.env.COMSPEC || "cmd.exe",
      buildArgs: (cmd) => ["/s", "/c", cmd],
      isCmd: true,
    };
  } else {
    // macOS / Linux — use bash
    cachedShellConfig = {
      exe: "bash",
      buildArgs: (cmd) => ["-c", cmd],
      isCmd: false,
    };
  }
  return cachedShellConfig;
}

/** Reset the cached shell config (for testing or after env changes). */
export function resetShellConfig(): void {
  cachedShellConfig = null;
}

/**
 * Single composite regex matching environment variable names that should NOT
 * be passed to child processes.  These contain secrets (API keys, tokens) that
 * could be leaked if the LLM-generated command runs `env`, `printenv`, or
 * exfiltrates env vars.
 *
 * Previously this was an array of ~20 individual RegExp objects tested via
 * `SENSITIVE_ENV_PATTERNS.some(p => p.test(key))` — with ~100+ env vars on
 * a typical system, that's ~2000+ regex compilations/tests per cache miss.
 * Compiling all patterns into a single alternation regex performs a single
 * `regex.test(key)` per env var, reducing the matching cost by ~20× and avoiding
 * the `.some()` callback overhead.  The regex engine can also optimize shared
 * prefixes/suffixes across alternation branches.
 *
 * Pattern groups:
 *   1. Exact-match well-known secret variable names
 *   2. Connection string URLs (frequently embed passwords inline)
 *   3. Cloud provider secrets not matched by generic patterns
 *   4. Generic substring/suffix patterns for secrets/tokens/passwords/credentials
 *
 * The `_KEY$` suffix was intentionally replaced with specific `_*_KEY$` suffixes.
 * The old `_KEY$` pattern matched benign variables like `REGISTRY_KEY`, `SORT_KEY`,
 * `PRIMARY_KEY`, `DISPLAY_KEY`, etc., removing env vars that child processes may
 * legitimately need. The new specific suffixes (`_API_KEY`, `_SECRET_KEY`,
 * `_AUTH_KEY`, `_SIGNING_KEY`, `_ENCRYPTION_KEY`, `_MASTER_KEY`) target only
 * variables overwhelmingly associated with actual secrets. The standalone
 * `API_KEY$` (without leading underscore) was also removed since the exact-match
 * list already covers every well-known `*API_KEY` variable (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GOOGLE_API_KEY, STRIPE_API_KEY, SENDGRID_API_KEY) and the
 * `_API_KEY$` suffix catches custom ones like `MY_SERVICE_API_KEY`.
 */
const SENSITIVE_ENV_RE = new RegExp(
  // Exact matches for well-known secrets
  "^(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|" +
  "AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|NPM_TOKEN|" +
  "HUGGING_FACE_HUB_TOKEN|HF_TOKEN|SLACK_TOKEN|SLACK_BOT_TOKEN|" +
  "DISCORD_TOKEN|STRIPE_SECRET_KEY|STRIPE_API_KEY|SENDGRID_API_KEY|" +
  "TWILIO_AUTH_TOKEN|" +
  // Connection strings (embed passwords inline)
  "DATABASE_URL|REDIS_URL|MONGO_URI|MONGODB_URI|AMQP_URL|" +
  // Cloud provider secrets
  "AZURE_CLIENT_SECRET|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|" +
  "VAULT_TOKEN|DATABRICKS_TOKEN)$" +
  // Generic patterns — substring or suffix matches
  "|SECRET|PRIVATE_KEY$|ACCESS_TOKEN$|PASSWORD|_TOKEN$" +
  "|_API_KEY$|_SECRET_KEY$|_AUTH_KEY$|_SIGNING_KEY$|_ENCRYPTION_KEY$|_MASTER_KEY$" +
  "|CREDENTIAL|CONNECTION_STRING",
  "i"
);

/**
 * Create a sanitized copy of process.env with sensitive variables removed.
 * This prevents accidental API key leakage when the LLM runs shell commands
 * like `env`, `printenv`, or `curl` that might expose environment variables.
 *
 * The result is cached because SENSITIVE_ENV_RE is static and
 * process.env rarely changes between invocations. Each Bash tool call
 * previously created a full shallow copy of process.env (~100+ keys)
 * and ran regex matching on every key — measurable overhead when the
 * model issues many Bash calls in quick succession. The cache is
 * invalidated by calling `resetSanitizedEnvCache()` (e.g., if env
 * vars are updated mid-session, though this is rare in practice).
 */
let cachedSanitizedEnv: NodeJS.ProcessEnv | null = null;

function getSanitizedEnv(): NodeJS.ProcessEnv {
  if (cachedSanitizedEnv) return cachedSanitizedEnv;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV_RE.test(key)) {
      delete env[key];
    }
  }
  cachedSanitizedEnv = env;
  return env;
}

/** Clear the cached sanitized environment so the next call rebuilds it. */
export function resetSanitizedEnvCache(): void {
  cachedSanitizedEnv = null;
}

// Automatically invalidate the cached sanitized env when config is reset.
// Config changes (e.g., settings.json env overrides) can affect which env vars
// are available to child processes. Without this, the stale cached env from
// before the config reset would be used for all subsequent Bash tool calls.
onConfigReset(resetSanitizedEnvCache);
// Also reset the shell config cache so CODINGAGENT_SHELL changes take effect.
onConfigReset(resetShellConfig);

/** Maximum timeout for Bash commands (10 minutes). */
const MAX_TIMEOUT_MS = 600_000;

/**
 * Mapping from signal numbers to their symbolic names, used to annotate
 * exit codes > 128 (which conventionally mean "killed by signal N" in bash).
 * Hoisted to module scope so the object is allocated once and reused across
 * all Bash tool invocations, rather than being recreated inside the `close`
 * handler on every non-zero exit (previously allocated ~12 key-value pairs
 * per command that exited with code > 128).
 */
const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL",
  6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 11: "SIGSEGV",
  13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM",
  24: "SIGXCPU", 25: "SIGXFSZ",
};

/**
 * Brief explanations for well-known process signals, shown when a command is
 * killed by a signal (code === null). Helps the model diagnose the cause
 * without needing to know Unix signal semantics.
 * Hoisted to module scope so the object is allocated once and reused across
 * all Bash tool invocations, rather than being recreated inside the `close`
 * handler on every signal-killed command exit.
 */
const SIGNAL_HINTS: Readonly<Record<string, string>> = {
  SIGHUP: "terminal disconnected or controlling process ended",
  SIGINT: "interrupt signal (Ctrl+C in the child process or external INT)",
  SIGQUIT: "quit signal (Ctrl+\\ — produces core dump if enabled)",
  SIGKILL: "usually the OOM killer or an external `kill -9`",
  SIGSEGV: "segmentation fault (memory access violation)",
  SIGBUS: "bus error (misaligned memory access or I/O error)",
  SIGABRT: "the process called abort() — often an assertion failure",
  SIGTERM: "graceful termination request (manual kill or abort handler)",
  SIGPIPE: "write to a pipe/socket with no reader",
  SIGFPE: "arithmetic error (e.g., division by zero in native code)",
  SIGILL: "illegal CPU instruction (binary incompatibility or corruption)",
  SIGALRM: "timer alarm expired (e.g., from `timeout` command or `alarm()` syscall)",
  SIGXCPU: "CPU time limit exceeded (common in sandboxed/containerized environments)",
  SIGXFSZ: "file size limit exceeded (ulimit -f)",
};

export const bashTool: Tool = {
  name: "Bash",
  description:
    process.platform === "win32"
      ? "Execute a command. Each command runs in a fresh shell (cmd.exe on Windows) in the context's working directory."
      : "Execute a bash command. Each command runs in a fresh shell in the context's working directory.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The command to execute",
      },
      description: {
        type: "string",
        description: "Description of what this command does",
      },
      timeout: {
        type: "number",
        description: `Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS})`,
      },
    },
    required: ["command"],
  },
  isConcurrencySafe: false,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let command: string;
    let timeout: number;
    try {
      command = requireString(input, "command");
      // Clamp timeout to [1000, 600000] ms. Without a minimum, timeout=0
      // would create a setTimeout(..., 0) that kills the command before it
      // produces any output, making it appear as a mysterious failure.
      timeout = Math.max(1000, Math.min(optionalInteger(input, "timeout") ?? 120_000, MAX_TIMEOUT_MS));
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      throw err;
    }

    // Reject extremely long commands to prevent issues with bash argument
    // limits and to avoid spending minutes parsing a multi-MB hallucinated
    // command string. The Linux ARG_MAX is typically 2 MB; on macOS it's
    // 256 KB. We use 100 KB as a conservative, cross-platform limit.
    const MAX_COMMAND_LENGTH = 100_000;
    if (command.length > MAX_COMMAND_LENGTH) {
      return {
        content: `Error: Command is too long (${command.length.toLocaleString()} chars, max ${MAX_COMMAND_LENGTH.toLocaleString()}). Write the command to a script file and execute that instead.`,
        is_error: true,
      };
    }

    // Reject commands containing null bytes. Bash interprets `\0` as a
    // string terminator — `bash -c "echo hello\0rm -rf /"` silently
    // truncates to `echo hello`, discarding everything after the null byte.
    // cmd.exe on Windows also misbehaves with null bytes (truncation or
    // garbled output). This is both a security and correctness concern.
    if (command.includes("\0")) {
      return {
        content: `Error: Command contains null byte(s) which would cause the shell to silently truncate the command. Remove any \\0 characters.`,
        is_error: true,
      };
    }

    // Reject whitespace-only commands. `requireString` already rejects empty
    // strings, but a command like `"  "` or `"\n\t"` passes that check and
    // spawns `bash -c "  "` which exits 0 with no output — silently wasting
    // a tool call. Catch this early with a clear message.
    if (command.trim().length === 0) {
      return {
        content: `Error: Command is empty (whitespace only). Provide an actual command to execute.`,
        is_error: true,
      };
    }

    // Check for abort before spawning a child process. Without this, if
    // the signal is already aborted when execute() is called (e.g., user
    // pressed Ctrl+C while multiple Bash calls were queued), we'd spawn
    // bash only to immediately kill it via the abortHandler listener —
    // wasting a process fork, a shell startup, and adding latency.
    if (context.abortController.signal.aborted) {
      return { content: "Aborted by user.", is_error: true };
    }

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let timedOut = false;
      // Guard against double resolution — Node.js child processes can emit
      // both "error" and "close" events (e.g., ENOENT fires "error" first,
      // then "close" with null code).  While Promises silently ignore the
      // second resolve(), redundant cleanup logic still runs. This flag
      // prevents that and makes the intent explicit.
      let settled = false;

      // ── Buffer size caps ──
      // Track total bytes accumulated for stdout and stderr to prevent OOM
      // when a command produces unbounded output (e.g., `yes`, `cat /dev/urandom`).
      // The caps are sized to slightly exceed the string-level truncation
      // thresholds (30K chars for stdout, 10K for stderr) so that the
      // truncation message can report accurate context. Previously the caps
      // were 32 MB / 10 MB — far larger than the 30K/10K char truncation
      // limits, meaning 99.9%+ of captured data was immediately discarded.
      // A `yes` command could allocate 32 MB of Buffers in the node heap
      // before the stream was destroyed, causing unnecessary memory pressure.
      // 512 KB / 256 KB is generous: 30K UTF-8 chars ≤ 120 KB, so 512 KB
      // provides ~4× headroom for multi-byte content while staying well
      // below the 32 MB that was previously allocated.
      const STDOUT_CAP = 512 * 1024; // 512 KB
      const STDERR_CAP = 256 * 1024; // 256 KB
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncatedByCapture = false;
      let stderrTruncatedByCapture = false;

      const shell = getShellConfig();
      const proc = spawn(shell.exe, shell.buildArgs(command), {
        cwd: context.cwd,
        env: getSanitizedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Manual timeout tracking so we can report it clearly to the user.
      // Node's built-in spawn `timeout` option sends SIGTERM but doesn't
      // distinguish from other failures in the close handler.
      // Track the SIGKILL follow-up timer so it can be cleared if the process
      // exits promptly after the initial SIGTERM.  Without clearing, the timer
      // lingers for 5 seconds (unref'd, so it won't block exit, but it's still
      // a wasted resource and could fire after the promise has already resolved).
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        try { proc.kill("SIGTERM"); } catch { /* already exited */ }
        // If SIGTERM doesn't work, force kill after 5 seconds
        killTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* already exited */ }
        }, 5000);
        killTimer.unref();
      }, timeout);
      timeoutId.unref();

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutTruncatedByCapture) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > STDOUT_CAP) {
          stdoutTruncatedByCapture = true;
          // Keep only the portion that fits within the cap
          const excess = stdoutBytes - STDOUT_CAP;
          if (excess < chunk.length) {
            let end = chunk.length - excess;
            // Avoid splitting a multi-byte UTF-8 sequence at the cut point.
            // UTF-8 continuation bytes have the pattern 10xxxxxx (0x80-0xBF).
            // If the byte at the cut point is a continuation byte, the cut
            // lands in the middle of a multi-byte character — back up to
            // exclude the entire character. Without this, Buffer.toString("utf-8")
            // produces U+FFFD (replacement character) for the orphaned bytes,
            // showing garbled text to the model at the truncation boundary.
            while (end > 0 && (chunk[end] & 0xc0) === 0x80) {
              end--;
            }
            if (end > 0) {
              chunks.push(chunk.subarray(0, end));
            }
          }
          // Destroy the stream to stop the process from buffering more data
          try { proc.stdout?.destroy(); } catch { /* best-effort */ }
        } else {
          chunks.push(chunk);
        }
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        if (stderrTruncatedByCapture) return;
        stderrBytes += chunk.length;
        if (stderrBytes > STDERR_CAP) {
          stderrTruncatedByCapture = true;
          const excess = stderrBytes - STDERR_CAP;
          if (excess < chunk.length) {
            let end = chunk.length - excess;
            // Same UTF-8 boundary fix as stdout — see comment above.
            while (end > 0 && (chunk[end] & 0xc0) === 0x80) {
              end--;
            }
            if (end > 0) {
              errChunks.push(chunk.subarray(0, end));
            }
          }
          try { proc.stderr?.destroy(); } catch { /* best-effort */ }
        } else {
          errChunks.push(chunk);
        }
      });

      // Handle abort — use { once: true } as a belt-and-suspenders approach.
      // The listener is also manually removed in the close/error handlers, but
      // { once: true } ensures cleanup even if the process becomes a zombie and
      // never fires close, preventing a listener leak on the parent signal.
      //
      // Escalate to SIGKILL after 5 seconds if the process doesn't exit from
      // SIGTERM — mirrors the timeout handler's escalation pattern. Without
      // this, processes that trap SIGTERM (e.g., npm install, docker build,
      // webpack) can hang indefinitely after the user presses Ctrl+C, making
      // the agent unresponsive. The SIGKILL timer is tracked in `killTimer`
      // (shared with the timeout handler) and cleared in the close handler.
      let abortKillTimer: ReturnType<typeof setTimeout> | null = null;
      const abortHandler = () => {
        try { proc.kill("SIGTERM"); } catch { /* already exited */ }
        abortKillTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* already exited */ }
        }, 5000);
        abortKillTimer.unref();
      };
      context.abortController.signal.addEventListener("abort", abortHandler, { once: true });

      proc.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        // Clear the SIGKILL follow-up timer if the process exited promptly
        // after SIGTERM — no need to escalate to SIGKILL.
        if (killTimer !== null) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        // Clear the abort-triggered SIGKILL escalation timer if the process
        // exited promptly after the Ctrl+C SIGTERM — same pattern as above.
        if (abortKillTimer !== null) {
          clearTimeout(abortKillTimer);
          abortKillTimer = null;
        }
        context.abortController.signal.removeEventListener(
          "abort",
          abortHandler
        );

        let stdout = Buffer.concat(chunks).toString("utf-8");
        let stderr = Buffer.concat(errChunks).toString("utf-8");

        // Truncate large output (string-level truncation for the API response).
        // If capture-level truncation already occurred, note it in the message.
        // Uses the shared safeTruncate() helper which avoids splitting UTF-16
        // surrogate pairs (e.g., emoji, CJK characters) that would produce
        // malformed Unicode when sent to the API.
        if (stdout.length > 30000) {
          stdout = safeTruncate(stdout, 30000) + "\n... (output truncated)";
        } else if (stdoutTruncatedByCapture) {
          stdout += "\n... (output truncated — exceeded 512 KB capture limit)";
        }
        if (stderr.length > 10000) {
          stderr = safeTruncate(stderr, 10000) + "\n... (stderr truncated)";
        } else if (stderrTruncatedByCapture) {
          stderr += "\n... (stderr truncated — exceeded 256 KB capture limit)";
        }

        let content = "";
        if (stdout) content += stdout;
        if (stderr) content += (content ? "\n" : "") + "STDERR:\n" + stderr;
        // When a command produces no stdout/stderr, show the exit code so the
        // model can confirm the command succeeded (exit 0) or diagnose failure.
        // Previously the bare `(no output)` message gave no indication whether
        // the command worked — a silent `rm`, `mkdir`, or `cp` that succeeded
        // (code 0) looked identical to a failed command that produced no output
        // (code 1+). Including the exit code lets the model self-correct without
        // an extra `echo $?` call.
        if (!content) {
          content = code === 0
            ? "(no output — exit code 0)"
            // When code is null, the process was killed by a signal (not by
            // exiting with a status). Saying "exit code unknown" is misleading
            // because there IS no exit code — the process didn't exit normally.
            // "killed by signal" is accurate and helps the model understand
            // there's no exit code to inspect (e.g., via `echo $?`).
            : code !== null
              ? `(no output — exit code ${code})`
              : "(no output — killed by signal)";
        }

        if (timedOut) {
          content += `\n\nError: Command timed out after ${timeout / 1000}s and was killed. Try increasing the timeout parameter (max ${MAX_TIMEOUT_MS / 1000}s) or breaking the command into smaller steps.`;
        } else if (code !== null && code !== 0) {
          // Append a cause hint for well-known exit codes so the model can
          // diagnose the issue without external knowledge. Previously the bare
          // "Exit code: 127" gave no context — the model would need to know
          // bash exit code conventions to understand that 127 means "command
          // not found", and without that knowledge it often retried the same
          // command or gave a generic "the command failed" response.
          //
          // Exit codes 126–128 are bash-specific conventions (POSIX):
          //   126: command found but not executable (permission denied)
          //   127: command not found in PATH
          //   128: invalid exit argument
          // Exit codes 129–192 (128+N) indicate the process was killed by
          // signal N — e.g., 137 = 128+9 = SIGKILL. These overlap with the
          // `code === null` signal branch, but some shells (notably bash)
          // report signal kills as exit codes rather than null codes.
          let exitHint = "";
          if (code === 126) {
            exitHint = " (command not executable — check file permissions with `ls -la` or add `chmod +x`)";
          } else if (code === 127) {
            exitHint = " (command not found — check the command name or install the missing tool)";
          } else if (code === 128) {
            exitHint = " (invalid exit argument)";
          } else if (code > 128 && code <= 192) {
            // 128+N means killed by signal N. Map common signal numbers to names.
            const signalNum = code - 128;
            const sigName = SIGNAL_NAMES[signalNum];
            exitHint = sigName
              ? ` (killed by signal ${signalNum}/${sigName})`
              : ` (killed by signal ${signalNum})`;
          }
          content += `\n\nExit code: ${code}${exitHint}`;
        } else if (code === null) {
          // Determine whether this signal kill was user-initiated (Ctrl+C) BEFORE
          // appending diagnostic messages. The user's abort handler sends SIGTERM
          // to the child process, which produces `code === null, signal === "SIGTERM"`.
          // Without this check, the user sees "Process was killed by SIGTERM
          // (graceful termination request)" — a misleading diagnostic that makes it
          // look like something went wrong, when the user intentionally cancelled.
          // The model also sees this message and may waste a turn trying to "fix"
          // the SIGTERM, retrying the same command or investigating why it was killed.
          //
          // For user-initiated aborts, append a clear "Command cancelled" message
          // instead. For genuine external signals (OOM killer → SIGKILL, segfault →
          // SIGSEGV, etc.), keep the full diagnostic with signal name and hint.
          if (context.abortController.signal.aborted) {
            content += "\n\nCommand cancelled by user (Ctrl+C).";
          } else {
            // Include the signal name (SIGTERM, SIGKILL, SIGSEGV, etc.) so the
            // model/user can diagnose the cause. Node.js provides the signal via
            // the `close` event's second parameter.
            const sigName = signal ?? "unknown signal";
            // Append a brief cause hint for well-known signals so the model can
            // diagnose the issue without external knowledge. Previously the bare
            // signal name (e.g., "SIGKILL") gave no context — the model would
            // need to know Unix signal semantics to understand why the process
            // was killed, and without that knowledge it often retried the same
            // command or gave a generic "the process was killed" response.
            const hint = typeof sigName === "string" ? SIGNAL_HINTS[sigName] : undefined;
            content += hint
              ? `\n\nProcess was killed by ${sigName} (${hint}).`
              : `\n\nProcess was killed by ${sigName}.`;
          }
        }

        // Determine if the result is an error:
        // - Timeout is always an error
        // - Non-zero exit code is an error
        // - Process killed by signal (code === null): only an error if the
        //   user didn't initiate the abort (Ctrl+C). When the user presses
        //   Ctrl+C, the process is killed via our abort handler (SIGTERM),
        //   which results in code === null — treating this as an error wastes
        //   a model turn trying to "fix" expected behavior.
        const isUserAbort = code === null && context.abortController.signal.aborted;
        const isError = timedOut || (code !== null && code !== 0) || (code === null && !isUserAbort);
        resolve({ content, is_error: isError });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        // Clear the SIGKILL follow-up timer if it's armed — same cleanup as
        // in the "close" handler.  Without this, if a timeout fires (setting
        // killTimer) and then "error" fires instead of "close" (e.g., EPERM
        // on Windows), the SIGKILL timer lingers for 5 seconds and may fire
        // after the promise has already resolved.
        if (killTimer !== null) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        // Clear the abort-triggered SIGKILL escalation timer — same pattern.
        if (abortKillTimer !== null) {
          clearTimeout(abortKillTimer);
          abortKillTimer = null;
        }
        context.abortController.signal.removeEventListener(
          "abort",
          abortHandler
        );

        // Provide actionable guidance when bash is not found or access is denied.
        // ENOENT can mean either "bash executable not found" or "the working
        // directory (context.cwd) doesn't exist". Distinguish the two so the
        // user/LLM gets an actionable message instead of a misleading
        // "bash is not installed" when the CWD was deleted or is invalid.
        // EACCES fires when the working directory exists but the process lacks
        // execute permission on it — `spawn` fails before bash even starts.
        let errorContent: string;
        if (hasErrnoCode(err) && err.code === "ENOENT") {
          // Check whether the cwd exists to disambiguate
          let cwdExists = true;
          try {
            statSync(context.cwd);
          } catch {
            cwdExists = false;
          }

          if (!cwdExists) {
            errorContent =
              `Error: Working directory does not exist: ${context.cwd}\n` +
              "  • The directory may have been deleted or renamed.\n" +
              "  • Use a command with an absolute path, or change the working directory.";
          } else {
            const shellName = shell.isCmd ? "cmd.exe" : shell.exe;
            errorContent =
              `Error: ${shellName} is not installed or not in PATH.\n` +
              (process.platform === "win32"
                ? shell.isCmd
                  ? "  • COMSPEC may be misconfigured. Verify that %COMSPEC% points to cmd.exe."
                  : "  • Install Git for Windows (includes Git Bash): https://gitforwindows.org\n  • Or install WSL: wsl --install"
                : "  • Install bash via your system package manager (e.g. apt install bash)");
          }
        } else if (hasErrnoCode(err) && err.code === "EACCES") {
          // EACCES on spawn typically means the working directory lacks
          // execute (+x) permission, or (rarely) the bash binary itself is
          // not executable. Check the cwd first since that's the common case.
          errorContent =
            `Error: Permission denied when spawning command in ${context.cwd}\n` +
            "  • The working directory may lack execute permission.\n" +
            "  • Check directory permissions with: ls -la " + context.cwd;
        } else if (hasErrnoCode(err) && err.code === "EPERM") {
          // EPERM is the Windows equivalent of EACCES for many permission-denied
          // scenarios. Windows returns EPERM when: (1) the working directory is
          // protected by UAC or NTFS permissions, (2) a file is locked by another
          // process, or (3) antivirus/security software blocks the spawn. Without
          // a specific hint, the user sees a bare "Error: EPERM: operation not
          // permitted" with no guidance — on Windows this is the most common
          // permission error (EACCES is rare), so hitting the generic fallback
          // loses the actionable "check permissions" advice.
          errorContent =
            `Error: Operation not permitted when spawning command in ${context.cwd}\n` +
            "  • The directory or command may be blocked by permissions, antivirus, or another process.\n" +
            "  • On Windows, try running the terminal as Administrator.\n" +
            "  • Check if the path is accessible: dir " + context.cwd;
        } else if (hasErrnoCode(err) && err.code === "ENOTDIR") {
          // ENOTDIR fires when context.cwd exists but is a regular file (not
          // a directory). This can happen if context.cwd was set to a file
          // path by mistake, or if a parent directory component was replaced
          // by a file after the cwd was resolved. The generic `Error: ENOTDIR`
          // message from Node.js gives no hint about which path is wrong.
          errorContent =
            `Error: Working directory is not a directory: ${context.cwd}\n` +
            "  • The path exists but is a file, not a directory.\n" +
            "  • Use a Bash command with an absolute path, or verify the working directory.";
        } else {
          errorContent = `Error: ${err.message}`;
        }
        resolve({ content: errorContent, is_error: true });
      });
    });
  },
};
